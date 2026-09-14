from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from github_publisher import GitHubIssue  # noqa: E402
from runner import (  # noqa: E402
    ControllerRunner,
    HealthState,
    RunnerConfig,
    RunnerConfigError,
    _log,
)
from sentry import SentryConfig  # noqa: E402
from store import IssueInput, RepairStore  # noqa: E402


RUN_AT = datetime(2026, 9, 14, 15, 0, tzinfo=timezone.utc).timestamp()


def env_for(path: Path, **overrides: str) -> dict[str, str]:
    values = {
        "SANDRA_REPAIR_DB_PATH": str(path),
        "SANDRA_REPAIR_VOLUME_PATH": str(path.parent),
        "SENTRY_AUTH_TOKEN": "sentry-token-value",
    }
    values.update(overrides)
    return values


def config_from_env(values: dict[str, str]) -> RunnerConfig:
    """Treat a temporary test directory as the mounted Railway volume."""

    with patch("runner._is_effective_mount", return_value=True):
        return RunnerConfig.from_env(values)


class FakeTokenProvider:
    def get_token(self):
        return "installation-token-value"


class FakeSentry:
    def __init__(self, *, issue_number: int = 123, failure: Exception | None = None):
        self.config = SentryConfig()
        self.issue_number = issue_number
        self.failure = failure
        self.calls = 0

    def retrieve_all(self, _cursor=None):
        self.calls += 1
        if self.failure is not None:
            raise self.failure
        return [
            IssueInput(
                self.issue_number,
                title="telemetry title is never published",
                release="a" * 40,
                event_id="event-123",
                first_seen="2026-09-14T14:00:00Z",
                last_seen="2026-09-14T15:00:00Z",
                payload={"message": "private value", "count": 2},
            )
        ], "terminal-cursor"


class FakeGitHub:
    repository = "biginkc/sandra"

    def __init__(self):
        self.find_calls = 0
        self.create_calls = 0

    def find_marker(self, _marker, _labels):
        self.find_calls += 1
        return None

    def create_issue(self, title, body, labels):
        self.create_calls += 1
        return GitHubIssue(
            number=9,
            html_url="https://github.com/biginkc/sandra/issues/9",
            node_id="node-9",
            title=title,
            body=body,
            labels=tuple(labels),
        )


class RunnerTests(unittest.TestCase):
    def test_environment_requires_absolute_durable_path_and_sentry_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repair.db"
            config = config_from_env(env_for(path))
            self.assertEqual(config.db_path, path.resolve())
            self.assertFalse(config.github_publish_enabled)
            self.assertNotIn("sentry-token-value", repr(config))
        with self.assertRaisesRegex(RunnerConfigError, "absolute durable"):
            config_from_env(
                {
                    "SANDRA_REPAIR_DB_PATH": "relative.db",
                    "SANDRA_REPAIR_VOLUME_PATH": "/tmp",
                    "SENTRY_AUTH_TOKEN": "long-enough",
                }
            )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repair.db"
            with self.assertRaisesRegex(RunnerConfigError, "GITHUB_TOKEN"):
                config_from_env(
                    env_for(
                        path,
                        SANDRA_GITHUB_PUBLISH_ENABLED="true",
                        GITHUB_TOKEN="legacy-static-token",
                    )
                )

    def test_volume_must_be_a_writable_mount_and_database_must_be_inside_it(self):
        with tempfile.TemporaryDirectory() as directory:
            volume = Path(directory) / "volume"
            volume.mkdir()
            db = volume / "repair.db"
            values = env_for(db, SANDRA_REPAIR_VOLUME_PATH=str(volume))
            with self.assertRaisesRegex(RunnerConfigError, "effective mounted"):
                RunnerConfig.from_env(values)
            with patch("runner._is_effective_mount", return_value=True):
                self.assertEqual(RunnerConfig.from_env(values).volume_path, volume.resolve())
                with self.assertRaisesRegex(RunnerConfigError, "reside under"):
                    RunnerConfig.from_env(
                        env_for(Path(directory) / "outside.db", SANDRA_REPAIR_VOLUME_PATH=str(volume))
                    )

    def test_dispatch_requires_future_gate_and_is_disabled_by_default(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repair.db"
            config = config_from_env(env_for(path))
            self.assertFalse(config.repair_dispatch_enabled)
            with self.assertRaisesRegex(RunnerConfigError, "staged-v1"):
                config_from_env(env_for(path, SANDRA_REPAIR_DISPATCH_ENABLED="true"))
            with self.assertRaisesRegex(RunnerConfigError, "reserved"):
                config_from_env(
                    env_for(
                        path,
                        SANDRA_REPAIR_DISPATCH_ENABLED="true",
                        SANDRA_REPAIR_DISPATCH_GATE="staged-v1",
                    )
                )

    def test_slot_claim_is_restart_safe_and_does_not_replay_intake(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repair.db"
            config = RunnerConfig(db_path=path, sentry_token="sentry-token-value", health_port=0)
            first_sentry = FakeSentry()
            first = ControllerRunner(config, sentry_client=first_sentry)
            self.assertEqual(first.run_once(RUN_AT).status, "completed")
            self.assertEqual(first_sentry.calls, 1)
            first.close()

            second_sentry = FakeSentry()
            second_store = RepairStore(path)
            second = ControllerRunner(config, store=second_store, sentry_client=second_sentry)
            self.assertEqual(second.run_once(RUN_AT).status, "not_due")
            self.assertEqual(second_sentry.calls, 0)
            self.assertEqual(len(second_store.list_issues("bmh-group", "sandra", "vercel-production")), 1)
            second.close()

    def test_github_publishing_is_disabled_without_mutating_outbox(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repair.db"
            config = RunnerConfig(db_path=path, sentry_token="sentry-token-value", health_port=0)
            store = RepairStore(path)
            fake_sentry = FakeSentry()
            fake_github = FakeGitHub()
            runner = ControllerRunner(config, store=store, sentry_client=fake_sentry, github_client=fake_github)
            self.assertEqual(runner.run_once(RUN_AT).status, "completed")
            self.assertEqual(store.list_github_outbox(), [])
            self.assertEqual(fake_github.find_calls, 0)
            self.assertEqual(fake_github.create_calls, 0)
            runner.close()

    def test_enabled_publisher_uses_fake_client_and_sanitized_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repair.db"
            config = RunnerConfig(
                db_path=path,
                sentry_token="sentry-token-value",
                github_publish_enabled=True,
                github_app_id=1,
                github_installation_id=1,
                health_port=0,
            )
            store = RepairStore(path)
            fake_github = FakeGitHub()
            runner = ControllerRunner(
                config,
                store=store,
                sentry_client=FakeSentry(),
                github_client=fake_github,
                github_token_provider=FakeTokenProvider(),
            )
            result = runner.run_once(RUN_AT)
            self.assertEqual(result.status, "completed")
            self.assertEqual(result.queued, 1)
            self.assertEqual(result.published, 1)
            self.assertEqual(fake_github.find_calls, 1)
            self.assertEqual(fake_github.create_calls, 1)
            body = store.list_github_outbox()[0]["payload_json"]
            self.assertNotIn("private value", body)
            self.assertNotIn("github-token-value", body)
            runner.close()

    def test_failed_slot_retries_with_bounded_delay_and_never_logs_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repair.db"
            config = RunnerConfig(
                db_path=path,
                sentry_token="sentry-token-value",
                max_cycle_retries=2,
                backoff_base_seconds=2,
                backoff_max_seconds=3,
                health_port=0,
            )
            runner = ControllerRunner(
                config,
                sentry_client=FakeSentry(failure=RuntimeError("sentry-token-value")),
            )
            first = runner.run_once(RUN_AT)
            second = runner.run_once(RUN_AT + 30)
            third = runner.run_once(RUN_AT + 60)
            self.assertEqual(first.status, "failed")
            self.assertEqual(first.retry_delay_seconds, 2.0)
            self.assertEqual(second.status, "failed")
            self.assertEqual(second.retry_delay_seconds, 3.0)
            self.assertEqual(third.status, "failed")
            self.assertEqual(runner.run_once(RUN_AT + 90).status, "not_due")
            self.assertEqual(runner.health.payload()["status"], "degraded")
            runner.close()

    def test_health_endpoint_is_sanitized_and_signal_requests_graceful_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repair.db"
            config = RunnerConfig(
                db_path=path,
                sentry_token="sentry-token-value",
                health_host="127.0.0.1",
                health_port=0,
            )
            runner = ControllerRunner(config, sentry_client=FakeSentry())
            host, port = runner.start_health_server()
            with urlopen(f"http://{host}:{port}/healthz", timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(payload["service"], "sandra-sentry-repair")
            self.assertEqual(payload["status"], "starting")
            self.assertFalse(payload["ready"])
            with self.assertRaisesRegex(HTTPError, "HTTP Error 503") as not_ready:
                urlopen(f"http://{host}:{port}/readyz", timeout=2)
            not_ready.exception.close()
            self.assertEqual(runner.run_once(RUN_AT).status, "completed")
            with urlopen(f"http://{host}:{port}/readyz", timeout=2) as response:
                ready_payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(ready_payload["status"], "ok")
            self.assertTrue(ready_payload["ready"])
            self.assertNotIn("sentry-token-value", json.dumps(payload))
            with patch("runner.signal.signal") as register:
                runner.install_signal_handlers()
                registered = [call.args[0] for call in register.call_args_list]
            self.assertIn(__import__("signal").SIGTERM, registered)
            self.assertIn(__import__("signal").SIGINT, registered)
            runner.request_stop()
            self.assertTrue(runner.stop_event.is_set())
            self.assertEqual(runner.health.payload()["status"], "stopping")
            runner.close()

    def test_restart_after_claimed_slot_before_intake_resumes_current_slot(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repair.db"
            store = RepairStore(path)
            slot_id = __import__("schedule").slot_identity(
                __import__("schedule").current_slot(datetime.fromtimestamp(RUN_AT, tz=timezone.utc))
            )
            self.assertTrue(store.claim_scheduler_slot(slot_id, RUN_AT, now=RUN_AT))
            store.close()
            sentry = FakeSentry()
            runner = ControllerRunner(
                RunnerConfig(db_path=path, sentry_token="sentry-token-value", health_port=0),
                store=RepairStore(path),
                sentry_client=sentry,
            )
            result = runner.run_once(RUN_AT + 1)
            self.assertEqual(result.status, "completed")
            self.assertEqual(sentry.calls, 1)
            self.assertEqual(runner.store.get_scheduler_slot(slot_id)["status"], "completed")
            runner.close()

    def test_health_degrades_on_first_intake_failure_and_recovers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repair.db"
            runner = ControllerRunner(
                RunnerConfig(db_path=path, sentry_token="sentry-token-value", health_port=0),
                sentry_client=FakeSentry(failure=RuntimeError("provider failure")),
            )
            self.assertEqual(runner.health.payload()["status"], "starting")
            self.assertEqual(runner.run_once(RUN_AT).status, "failed")
            payload = runner.health.payload()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["ready"])
            runner.close()

    def test_structured_log_filter_drops_token_fields(self):
        with patch.object(logging.getLogger("sandra.sentry-repair.runner"), "info") as info:
            _log("test", token="sentry-token-value", github_token="github-token-value", safe="ok")
            rendered = info.call_args.args[0]
        self.assertIn('"safe":"ok"', rendered)
        self.assertNotIn("sentry-token-value", rendered)
        self.assertNotIn("github-token-value", rendered)


if __name__ == "__main__":
    unittest.main()
