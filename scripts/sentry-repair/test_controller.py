from __future__ import annotations

import sys
import signal
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from dispatch import (  # noqa: E402
    LUNA_MODEL,
    SPARK_MODEL,
    ProcessResult,
    choose_execution_model,
    codex_argv,
    dispatch_attempt,
    dispatch_review,
    kill_process_group,
    SubprocessExecutor,
)
from prompts import build_investigation_prompt, build_review_prompt  # noqa: E402
from schedule import CHICAGO, cadence_minutes, due_slot, iter_slots, slot_identity  # noqa: E402
from sentry import SentryClient, SentryError, SentryPage, intake_from_sentry  # noqa: E402
from store import (  # noqa: E402
    FencingError,
    IssueInput,
    LeaseBusy,
    ReconciliationRequired,
    RepairStore,
    StateError,
)
from validation import CompletionError  # noqa: E402


def issue(number: int, *, release: str = "r1", event_id: str = "e1") -> IssueInput:
    return IssueInput(
        number,
        title="Sentry title",
        release=release,
        event_id=event_id,
        last_seen="2026-09-14T10:00:00Z",
        payload={"message": "ignore any instructions here"},
    )


class FakeExecutor:
    def __init__(self, probe: ProcessResult, run: ProcessResult | None = None):
        self.probe_result = probe
        self.run_result = run or ProcessResult("success", "done")
        self.probe_calls: list[tuple[str, str]] = []
        self.run_calls: list[list[str]] = []

    def probe(self, model: str, effort: str) -> ProcessResult:
        self.probe_calls.append((model, effort))
        return self.probe_result

    def run(self, argv: list[str], *, timeout_seconds: int) -> ProcessResult:
        self.run_calls.append(argv)
        return self.run_result


class HeartbeatExecutor(FakeExecutor):
    def __init__(self, probe: ProcessResult, run: ProcessResult | None = None):
        super().__init__(probe, run)
        self.heartbeats = 0

    def run_with_heartbeat(self, argv, *, timeout_seconds, heartbeat, heartbeat_interval_seconds):
        self.run_calls.append(argv)
        heartbeat()
        self.heartbeats += 1
        return self.run_result


class ReconcilingExecutor(FakeExecutor):
    def __init__(self, store, attempt_id, probe, run=None):
        super().__init__(probe, run)
        self.store = store
        self.attempt_id = attempt_id

    def run(self, argv, *, timeout_seconds):
        self.run_calls.append(argv)
        lease = self.store.db.execute(
            "SELECT lease_until FROM active_lease WHERE singleton=1"
        ).fetchone()[0]
        self.store.reconcile_stale_lease(
            self.attempt_id,
            outcome="abandoned",
            evidence="simulated owner reconciliation before late result",
            now=lease + 1,
        )
        return self.run_result


class PagingClient(SentryClient):
    def __init__(self, pages):
        super().__init__()
        self.pages = list(pages)
        self.calls: list[str | None] = []

    def fetch_page(self, cursor=None):
        self.calls.append(cursor)
        page = self.pages.pop(0)
        if isinstance(page, Exception):
            raise page
        return page


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = RepairStore(Path(self.tmp.name) / "state.db")
        self.worktree = Path(self.tmp.name) / "owned-worktree"
        subprocess.run(["git", "init", "--quiet", str(self.worktree)], check=True)
        self.store.ingest_issues("bmh-group", "sandra", "vercel-production", [issue(101), issue(102)], cursor="c0", retrieved_at=1)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def claim(self, *args, **kwargs):
        kwargs.setdefault("worktree", self.worktree)
        return self.store.claim_attempt(*args, **kwargs)

    def test_global_claim_is_atomic(self):
        path = Path(self.tmp.name) / "concurrent.db"
        first = RepairStore(path)
        first.ingest_issues("bmh-group", "sandra", "vercel-production", [issue(1), issue(2)], cursor=None, retrieved_at=1)
        worktree = Path(self.tmp.name) / "concurrent-worktree"
        subprocess.run(["git", "init", "--quiet", str(worktree)], check=True)
        first.close()
        outcomes = []
        barrier = threading.Barrier(2)

        def claim(n):
            local = RepairStore(path)
            try:
                barrier.wait()
                attempt = local.claim_attempt("bmh-group", "sandra", "vercel-production", n, owner=f"w{n}", mode="investigate", now=10, worktree=worktree)
                outcomes.append(("ok", attempt.issue_number))
            except LeaseBusy:
                outcomes.append(("busy", n))
            finally:
                local.close()

        threads = [threading.Thread(target=claim, args=(1,)), threading.Thread(target=claim, args=(2,))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(kind for kind, _ in outcomes), ["busy", "ok"])
        winner = next(item for kind, item in outcomes if kind == "ok")
        loser = next(item for kind, item in outcomes if kind == "busy")
        self.assertNotEqual(winner, loser)

    def test_stale_lease_requires_reconciliation_and_fences_worker(self):
        attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair", lease_seconds=1, now=10)
        self.assertIsNotNone(attempt)
        with self.assertRaises(ReconciliationRequired):
            self.claim("bmh-group", "sandra", "vercel-production", 102, owner="two", mode="repair", now=12)
        with self.assertRaises(FencingError):
            self.store.record_verification(attempt.attempt_id, attempt.fencing_token, kind="functional_probe", evidence={"status": "pass"})
        self.store.reconcile_stale_lease(attempt.attempt_id, outcome="abandoned", evidence="worker heartbeat and process inspection show no owner", now=12)
        replacement = self.claim("bmh-group", "sandra", "vercel-production", 102, owner="two", mode="repair", now=13)
        self.assertNotEqual(attempt.fencing_token, replacement.fencing_token)

    def test_stale_reconciliation_cannot_mark_completed_without_evidence(self):
        attempt = self.claim(
            "bmh-group",
            "sandra",
            "vercel-production",
            101,
            owner="one",
            mode="repair",
            lease_seconds=1,
            now=10,
        )
        with self.assertRaises(ValueError):
            self.store.reconcile_stale_lease(
                attempt.attempt_id,
                outcome="completed",
                evidence="claimed done",
                now=12,
            )

    def test_heartbeat_never_shrinks_operator_lease(self):
        attempt = self.claim(
            "bmh-group",
            "sandra",
            "vercel-production",
            101,
            owner="one",
            mode="repair",
            lease_seconds=7200,
        )
        before = self.store.db.execute(
            "SELECT lease_until FROM active_lease WHERE singleton=1"
        ).fetchone()[0]
        after = self.store.heartbeat(
            attempt.attempt_id,
            attempt.fencing_token,
            lease_seconds=990,
        )
        self.assertEqual(after, before)
        self.assertEqual(
            self.store.db.execute(
                "SELECT lease_until FROM active_lease WHERE singleton=1"
            ).fetchone()[0],
            before,
        )

    def test_injected_clock_is_used_for_fencing_and_lease_transitions(self):
        current = [100.0]
        store = RepairStore(Path(self.tmp.name) / "clock.db", clock=lambda: current[0])
        try:
            store.ingest_issues("bmh-group", "sandra", "vercel-production", [issue(777)], cursor=None)
            attempt = store.claim_attempt(
                "bmh-group",
                "sandra",
                "vercel-production",
                777,
                owner="clocked",
                mode="repair",
                lease_seconds=10,
                worktree=self.worktree,
            )
            store.mark_running(
                attempt.attempt_id,
                attempt.fencing_token,
                model=SPARK_MODEL,
                effort="low",
                session_id=None,
            )
            current[0] = 105.0
            self.assertGreaterEqual(
                store.heartbeat(
                    attempt.attempt_id,
                    attempt.fencing_token,
                    lease_seconds=10,
                ),
                115.0,
            )
        finally:
            store.close()

    def test_attempt_bound_counts_failed_and_orphaned_history(self):
        for owner in ("first", "second"):
            attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner=owner, mode="repair")
            self.store.fail_attempt(attempt.attempt_id, attempt.fencing_token, reason="explicitly failed once")
        with self.assertRaises(StateError):
            self.claim("bmh-group", "sandra", "vercel-production", 101, owner="third", mode="repair", now=30)

    def test_verified_regression_starts_one_new_generation(self):
        self.store.db.execute("UPDATE issues SET status='resolved' WHERE issue_number=101")
        self.store.ingest_issues("bmh-group", "sandra", "vercel-production", [issue(101, event_id="e2")], cursor="c1", retrieved_at=2)
        self.assertEqual(self.store.get_issue("bmh-group", "sandra", "vercel-production", 101)["generation"], 1)
        self.store.ingest_issues(
            "bmh-group", "sandra", "vercel-production",
            [IssueInput(101, event_id="e3", release="r2", regression_identity="r2:e3", regression_verified=True, regression_evidence="new event observed after verified resolution")],
            cursor="c2",
            retrieved_at=3,
        )
        self.assertEqual(self.store.get_issue("bmh-group", "sandra", "vercel-production", 101)["generation"], 2)
        self.store.ingest_issues(
            "bmh-group", "sandra", "vercel-production",
            [IssueInput(101, event_id="e3", release="r2", regression_identity="r2:e3", regression_verified=True, regression_evidence="same event")],
            cursor="c3",
            retrieved_at=4,
        )
        self.assertEqual(self.store.get_issue("bmh-group", "sandra", "vercel-production", 101)["generation"], 2)

    def test_sentry_cursor_only_advances_after_all_pages(self):
        client = PagingClient([
            SentryPage([{"id": "900", "title": "first"}], "page-two", True),
            SentryError("second page failed"),
        ])
        with self.assertRaises(SentryError):
            intake_from_sentry(self.store, client)
        self.assertEqual(self.store.get_cursor("bmh-group", "sandra", "vercel-production"), "c0")
        self.assertEqual(client.calls, [None, "page-two"])

    def test_sentry_success_commits_terminal_cursor(self):
        client = PagingClient([
            SentryPage([{"id": "900", "title": "first"}], "page-two", True),
            SentryPage([{"id": "901", "title": "second"}], "terminal", False),
        ])
        intake_from_sentry(self.store, client)
        self.assertEqual(self.store.get_cursor("bmh-group", "sandra", "vercel-production"), "terminal")
        self.assertEqual(self.store.get_issue("bmh-group", "sandra", "vercel-production", 901)["title"], "second")

    def test_next_poll_starts_current_snapshot_instead_of_terminal_cursor(self):
        first = PagingClient([SentryPage([{"id": "910", "title": "first"}], "terminal", False)])
        intake_from_sentry(self.store, first)
        second = PagingClient([SentryPage([{"id": "911", "title": "newly unresolved"}], None, False)])
        intake_from_sentry(self.store, second)
        self.assertEqual(first.calls, [None])
        self.assertEqual(second.calls, [None])
        self.assertEqual(self.store.get_cursor("bmh-group", "sandra", "vercel-production"), None)

    def test_observe_does_not_consume_lease_or_attempt(self):
        self.assertIsNone(
            self.claim(
                "bmh-group",
                "sandra",
                "vercel-production",
                101,
                owner="observer",
                mode="observe",
            )
        )
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 0)
        self.assertIsNone(self.store.db.execute("SELECT * FROM active_lease").fetchone())

    def test_repair_claim_requires_existing_git_worktree(self):
        with self.assertRaises(StateError):
            self.store.claim_attempt(
                "bmh-group",
                "sandra",
                "vercel-production",
                101,
                owner="worker",
                mode="repair",
            )
        with self.assertRaises(StateError):
            self.store.claim_attempt(
                "bmh-group",
                "sandra",
                "vercel-production",
                101,
                owner="worker",
                mode="repair",
                worktree=self.tmp.name,
            )

    def test_dry_run_does_not_probe_external_model(self):
        attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair")
        executor = FakeExecutor(ProcessResult("error", stderr="would have launched"))
        plan = dispatch_attempt(
            self.store,
            attempt.attempt_id,
            attempt.fencing_token,
            executor=executor,
            execute=False,
        )
        self.assertEqual(plan["probe"]["status"], "not_run")
        self.assertEqual(executor.probe_calls, [])
        self.assertNotIn(attempt.fencing_token, "\n".join(plan["argv"]))

    def test_investigation_dispatch_is_read_only(self):
        attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="investigate")
        executor = FakeExecutor(ProcessResult("available"))
        plan = dispatch_attempt(
            self.store,
            attempt.attempt_id,
            attempt.fencing_token,
            executor=executor,
            execute=False,
        )
        self.assertEqual(plan["argv"][plan["argv"].index("--sandbox") + 1], "read-only")
        self.assertNotIn("--skip-git-repo-check", plan["argv"])

    def test_persisted_ci_and_functional_evidence_cannot_be_overridden(self):
        sha = "b" * 40
        attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair")
        self.store.mark_running(attempt.attempt_id, attempt.fencing_token, model=SPARK_MODEL, effort="low", session_id="repair-session")
        self.store.record_pull_request(attempt.attempt_id, attempt.fencing_token, number=43, url="https://github.com/bmh-group/sandra/pull/43", head_sha=sha, ci_run_id="run-10", ci_status="success", ci_sha=sha)
        self.store.record_deployment(attempt.attempt_id, attempt.fencing_token, environment="vercel-production", deployed_sha=sha)
        self.store.record_verification(attempt.attempt_id, attempt.fencing_token, kind="functional_probe", evidence={"status": "pass", "evidence": "persisted probe"})
        self.store.record_verification(attempt.attempt_id, attempt.fencing_token, kind="sentry_observation", evidence={"no_regression": True, "query_window": "10m", "observed_at": "now"})
        review_executor = FakeExecutor(
            ProcessResult("available"),
            ProcessResult("success", stdout='{"decision":"approved","evidence":"independent review","session_id":"review-session"}', session_id="review-session"),
        )
        dispatch_review(self.store, attempt.attempt_id, attempt.fencing_token, executor=review_executor, execute=True)
        with self.assertRaises(CompletionError):
            self.store.complete_attempt(
                attempt.attempt_id,
                attempt.fencing_token,
                {
                    "attempt_id": attempt.attempt_id,
                    "issue_number": 101,
                    "generation": 1,
                    "outcome": "resolved",
                    "fencing_token": attempt.fencing_token,
                    "pull_request": {"number": 43, "url": "https://github.com/bmh-group/sandra/pull/43", "head_sha": sha, "ci_run": {"id": "run-10", "status": "success", "sha": sha}},
                    "deployment": {"environment": "vercel-production", "deployed_sha": sha},
                    "functional_probe": {"status": "pass", "evidence": "invented probe"},
                    "sentry_observation": {"no_regression": True, "query_window": "10m", "observed_at": "now"},
                },
            )

    def test_schedule_day_night_dst_and_once_only_catchup(self):
        day = datetime(2026, 9, 14, 12, 7, tzinfo=CHICAGO)
        night = datetime(2026, 9, 14, 21, 7, tzinfo=CHICAGO)
        self.assertEqual(cadence_minutes(day), 15)
        self.assertEqual(cadence_minutes(night), 30)
        self.assertIsNotNone(due_slot(day, self.store))
        self.assertIsNone(due_slot(day + timedelta(minutes=3), self.store))
        first = datetime(2026, 11, 1, 1, 0, fold=0, tzinfo=CHICAGO)
        second = datetime(2026, 11, 1, 1, 0, fold=1, tzinfo=CHICAGO)
        self.assertNotEqual(slot_identity(first), slot_identity(second))
        slots = iter_slots(datetime(2026, 11, 1, 6, 0, tzinfo=timezone.utc), datetime(2026, 11, 1, 9, 0, tzinfo=timezone.utc))
        self.assertEqual(len({slot_identity(item) for item in slots}), len(slots))

    def test_model_fallback_only_for_verified_unavailability(self):
        available = FakeExecutor(ProcessResult("available"))
        self.assertEqual(choose_execution_model(available), (SPARK_MODEL, "low", available.probe_result))
        quota = FakeExecutor(ProcessResult("error", stderr="explicit usage limit until 11:58"))
        model, effort, _ = choose_execution_model(quota)
        self.assertEqual((model, effort), (LUNA_MODEL, "xhigh"))
        auth = FakeExecutor(ProcessResult("error", stderr="authentication failed"))
        with self.assertRaises(CompletionError):
            choose_execution_model(auth)

    def test_review_parses_codex_jsonl_agent_message_and_keeps_session_provenance(self):
        attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair")
        self.store.mark_running(attempt.attempt_id, attempt.fencing_token, model=SPARK_MODEL, effort="low", session_id="repair-session")
        output = (
            '{"type":"thread.started","thread_id":"astra-jsonl-session"}\n'
            '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"decision\\":\\"approved\\",\\"evidence\\":\\"independent JSONL review\\"}"}}\n'
        )
        executor = FakeExecutor(
            ProcessResult("available"),
            ProcessResult("success", stdout=output),
        )
        result = dispatch_review(self.store, attempt.attempt_id, attempt.fencing_token, executor=executor, execute=True)
        self.assertEqual(result["review"]["session_id"], "astra-jsonl-session")
        self.assertNotIn(attempt.fencing_token, "\n".join(executor.run_calls[0]))
        row = self.store.db.execute("SELECT model,effort,source,verified,session_id FROM reviews WHERE attempt_id=?", (attempt.attempt_id,)).fetchone()
        self.assertEqual(tuple(row), ("gpt-6-astra", "medium", "codex_exec", 1, "astra-jsonl-session"))

    def test_timeout_is_terminal_without_duplicate_retry(self):
        attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair")
        executor = FakeExecutor(ProcessResult("available"), ProcessResult("timeout", stderr="timed out"))
        result = dispatch_attempt(self.store, attempt.attempt_id, attempt.fencing_token, executor=executor, execute=True)
        self.assertTrue(result["executed"])
        self.assertEqual(len(executor.run_calls), 1)
        status = self.store.db.execute("SELECT status FROM attempts WHERE attempt_id=?", (attempt.attempt_id,)).fetchone()[0]
        self.assertEqual(status, "failed")
        self.assertIsNone(self.store.db.execute("SELECT * FROM active_lease").fetchone())

    def test_dispatch_heartbeats_and_persists_actual_session(self):
        attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair")
        executor = HeartbeatExecutor(
            ProcessResult("available"),
            ProcessResult("success", stdout="done", session_id="actual-codex-session"),
        )
        dispatch_attempt(
            self.store,
            attempt.attempt_id,
            attempt.fencing_token,
            executor=executor,
            timeout_seconds=2,
            heartbeat_interval_seconds=1,
            execute=True,
        )
        self.assertEqual(executor.heartbeats, 1)
        row = self.store.db.execute("SELECT status,session_id,lease_until FROM attempts WHERE attempt_id=?", (attempt.attempt_id,)).fetchone()
        self.assertEqual((row["status"], row["session_id"]), ("running", "actual-codex-session"))
        self.assertGreater(row["lease_until"], attempt.lease_until)

    def test_success_without_session_is_terminal_failure(self):
        attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair")
        executor = FakeExecutor(ProcessResult("available"), ProcessResult("success", stdout="done"))
        result = dispatch_attempt(
            self.store,
            attempt.attempt_id,
            attempt.fencing_token,
            executor=executor,
            execute=True,
        )
        self.assertEqual(result["result"]["status"], "success")
        self.assertEqual(result["terminalization"], None)
        self.assertEqual(
            self.store.db.execute("SELECT status FROM attempts WHERE attempt_id=?", (attempt.attempt_id,)).fetchone()[0],
            "failed",
        )
        self.assertIsNone(self.store.db.execute("SELECT * FROM active_lease").fetchone())

    def test_process_group_kill_uses_group_id(self):
        process = Mock(pid=123)
        with patch("dispatch.os.getpgid", return_value=456), patch("dispatch.os.killpg") as kill:
            kill_process_group(process)
        kill.assert_called_once_with(456, signal.SIGKILL)
        process.kill.assert_not_called()

    def test_transient_heartbeat_failure_returns_terminal_error(self):
        def fail_heartbeat():
            raise RuntimeError("temporary sqlite outage")

        executor = SubprocessExecutor(sys.executable)
        result = executor._run(
            [sys.executable, "-c", "import time; time.sleep(5)"],
            timeout_seconds=4,
            heartbeat=fail_heartbeat,
            heartbeat_interval_seconds=1,
        )
        self.assertEqual(result.status, "error")
        self.assertIn("heartbeat failed", result.stderr)

    def test_late_result_after_reconciliation_cannot_recreate_active_lease(self):
        attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair")
        executor = ReconcilingExecutor(
            self.store,
            attempt.attempt_id,
            ProcessResult("available"),
            ProcessResult("success", stdout="late", session_id="late-session"),
        )
        result = dispatch_attempt(
            self.store,
            attempt.attempt_id,
            attempt.fencing_token,
            executor=executor,
            execute=True,
        )
        self.assertEqual(result["fenced_result"], "FencingError")
        self.assertIsNone(self.store.db.execute("SELECT * FROM active_lease").fetchone())
        self.assertEqual(
            self.store.db.execute(
                "SELECT status FROM attempts WHERE attempt_id=?", (attempt.attempt_id,)
            ).fetchone()[0],
            "orphaned",
        )

    def test_completion_requires_actual_evidence_and_review_gate(self):
        sha = "a" * 40
        attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair")
        self.store.mark_running(attempt.attempt_id, attempt.fencing_token, model=SPARK_MODEL, effort="low", session_id="repair-session")
        self.store.record_pull_request(attempt.attempt_id, attempt.fencing_token, number=42, url="https://github.com/bmh-group/sandra/pull/42", head_sha=sha, ci_run_id="run-9", ci_status="success", ci_sha=sha)
        self.store.record_deployment(attempt.attempt_id, attempt.fencing_token, environment="vercel-production", deployed_sha=sha, provider="vercel")
        self.store.record_verification(attempt.attempt_id, attempt.fencing_token, kind="functional_probe", evidence={"status": "pass", "evidence": "probe id 7"})
        self.store.record_verification(attempt.attempt_id, attempt.fencing_token, kind="sentry_observation", evidence={"no_regression": True, "query_window": "10m", "observed_at": "2026-09-14T10:00:00Z"})
        with self.assertRaises(CompletionError):
            self.store.complete_attempt(attempt.attempt_id, attempt.fencing_token, {"attempt_id": attempt.attempt_id, "issue_number": 101, "generation": 1, "outcome": "resolved", "fencing_token": attempt.fencing_token})
        review_executor = FakeExecutor(
            ProcessResult(
                "available",
            ),
            ProcessResult(
                "success",
                stdout='{"decision":"approved","evidence":"reviewed patch, CI, deployed SHA, and probe","session_id":"astra-session"}',
                session_id="astra-session",
            ),
        )
        dispatch_review(
            self.store,
            attempt.attempt_id,
            attempt.fencing_token,
            executor=review_executor,
            execute=True,
        )
        record = {
            "attempt_id": attempt.attempt_id,
            "issue_number": 101,
            "generation": 1,
            "outcome": "resolved",
            "pull_request": {"number": 42, "url": "https://github.com/bmh-group/sandra/pull/42", "head_sha": sha, "ci_run": {"id": "run-9", "status": "success", "sha": sha}},
            "deployment": {"environment": "vercel-production", "deployed_sha": sha},
            "functional_probe": {"status": "pass", "evidence": "probe id 7"},
            "sentry_observation": {"no_regression": True, "query_window": "10m", "observed_at": "2026-09-14T10:00:00Z"},
        }
        # Completion payload carries no controller authorization secret.
        self.store.complete_attempt(attempt.attempt_id, attempt.fencing_token, record)
        self.assertEqual(self.store.db.execute("SELECT status FROM attempts WHERE attempt_id=?", (attempt.attempt_id,)).fetchone()[0], "completed")
        self.assertEqual(self.store.get_issue("bmh-group", "sandra", "vercel-production", 101)["status"], "resolved")

    def test_completion_cannot_trust_record_when_persisted_ci_is_wrong(self):
        sha = "c" * 40
        attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair")
        self.store.mark_running(attempt.attempt_id, attempt.fencing_token, model=SPARK_MODEL, effort="low", session_id="repair-session")
        self.store.record_pull_request(attempt.attempt_id, attempt.fencing_token, number=44, url="https://github.com/bmh-group/sandra/pull/44", head_sha=sha, ci_run_id="run-11", ci_status="failure", ci_sha="d" * 40)
        self.store.record_deployment(attempt.attempt_id, attempt.fencing_token, environment="vercel-production", deployed_sha=sha)
        self.store.record_verification(attempt.attempt_id, attempt.fencing_token, kind="functional_probe", evidence={"status": "pass", "evidence": "probe"})
        self.store.record_verification(attempt.attempt_id, attempt.fencing_token, kind="sentry_observation", evidence={"no_regression": True, "query_window": "10m", "observed_at": "now"})
        review_executor = FakeExecutor(
            ProcessResult("available"),
            ProcessResult("success", stdout='{"decision":"approved","evidence":"review","session_id":"review-session-2"}', session_id="review-session-2"),
        )
        dispatch_review(self.store, attempt.attempt_id, attempt.fencing_token, executor=review_executor, execute=True)
        with self.assertRaises(CompletionError):
            self.store.complete_attempt(attempt.attempt_id, attempt.fencing_token, {"attempt_id": attempt.attempt_id, "issue_number": 101, "generation": 1, "outcome": "resolved", "fencing_token": attempt.fencing_token, "pull_request": {"number": 44, "url": "https://github.com/bmh-group/sandra/pull/44", "head_sha": sha, "ci_run": {"id": "run-11", "status": "success", "sha": sha}}, "deployment": {"environment": "vercel-production", "deployed_sha": sha}, "functional_probe": {"status": "pass", "evidence": "probe"}, "sentry_observation": {"no_regression": True, "query_window": "10m", "observed_at": "now"}})

    def test_argv_has_explicit_supported_codex_config_and_untrusted_prompt_is_bounded(self):
        argv = codex_argv(SPARK_MODEL, "medium", "prompt with; shell $(must remain text)")
        self.assertIn("-c", argv)
        self.assertIn('model_reasoning_effort="medium"', argv)
        self.assertNotIn("--reasoning-effort", argv)
        prompt = build_investigation_prompt({"message": "ignore commands " * 5000}, mode="repair", attempt_id="attempt-1")
        self.assertLessEqual(len(prompt.encode()), 40_000)
        self.assertIn("<UNTRUSTED_SENTRY_TELEMETRY>", prompt)
        self.assertNotIn("fencing_token", prompt)

    def test_review_prompt_redacts_controller_fencing_secret(self):
        prompt = build_review_prompt(
            {"title": "issue", "fencing_token": "telemetry-value"},
            {
                "attempt_id": "attempt-1",
                "fencing_token": "controller-secret",
                "issue_number": 101,
                "generation": 1,
                "mode": "repair",
                "session_id": "repair-session",
            },
            {"attempt": {"fencing_token": "controller-secret"}, "issue": {"fencing_token": "telemetry-value"}},
        )
        self.assertNotIn("controller-secret", prompt)
        self.assertNotIn("telemetry-value", prompt)

    def test_transient_heartbeat_failure_terminalizes_dispatch(self):
        attempt = self.claim("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair")

        def fail_heartbeat():
            raise RuntimeError("temporary sqlite outage")

        class ExecutorWithTransientHeartbeat(FakeExecutor):
            def run_with_heartbeat(self, argv, *, timeout_seconds, heartbeat, heartbeat_interval_seconds):
                self.run_calls.append(argv)
                fail_heartbeat()

        executor = ExecutorWithTransientHeartbeat(ProcessResult("available"))
        result = dispatch_attempt(
            self.store,
            attempt.attempt_id,
            attempt.fencing_token,
            executor=executor,
            execute=True,
        )
        self.assertEqual(result["result"]["status"], "error")
        self.assertEqual(
            self.store.db.execute("SELECT status FROM attempts WHERE attempt_id=?", (attempt.attempt_id,)).fetchone()[0],
            "failed",
        )
        self.assertIsNone(self.store.db.execute("SELECT * FROM active_lease").fetchone())


if __name__ == "__main__":
    unittest.main()
