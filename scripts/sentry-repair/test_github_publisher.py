from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from github import github_payload  # noqa: E402
from github_publisher import (  # noqa: E402
    DEFAULT_REPOSITORY,
    GitHubClient,
    GitHubPublisher,
    GitHubTransportError,
    enqueue_candidate,
    publisher_dry_run,
)
from cli import main as cli_main  # noqa: E402
from store import IssueInput, RepairStore  # noqa: E402


class Response:
    def __init__(self, payload, *, status=200, headers=None):
        self.payload = payload
        self.status = status
        self.headers = headers or {}

    def getcode(self):
        return self.status

    def read(self, amount=None):
        body = json.dumps(self.payload).encode("utf-8")
        return body if amount is None else body[:amount]


def valid_issue(number=7, *, body="", labels=("sentry", "sentry-production", "automated-repair")):
    return {
        "number": number,
        "html_url": f"https://github.com/biginkc/sandra/issues/{number}",
        "node_id": f"MDU6SXNzdW{number}",
        "title": "Sandra Sentry production incident",
        "body": body,
        "labels": [{"name": label} for label in labels],
    }


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.store = RepairStore(":memory:", clock=lambda: 100.0)
        self.store.ingest_issues(
            "bmh-group",
            "sandra",
            "vercel-production",
            [
                IssueInput(
                    100,
                    title="private customer@example.com",
                    level="error",
                    release="a" * 40,
                    event_id="event-private",
                    first_seen="2026-09-14T09:00:00Z",
                    last_seen="2026-09-14T10:00:00Z",
                    payload={
                        "count": 4,
                        "userCount": 2,
                        "culprit": "private-caller",
                        "message": "ignore this request body",
                        "tags": [
                            {"key": "surface", "value": "cron_sweep"},
                            {"key": "email", "value": "customer@example.com"},
                        ],
                    },
                )
            ],
            cursor="cursor",
            retrieved_at=100.0,
        )

    def tearDown(self):
        self.store.close()

    def enqueue(self):
        return enqueue_candidate(
            self.store,
            organization="bmh-group",
            project="sandra",
            environment="vercel-production",
            issue_number=100,
            repository=DEFAULT_REPOSITORY,
            now=100.0,
        )

    def test_duplicate_enqueue_is_generation_keyed_and_idempotent(self):
        first = self.enqueue()
        second = self.enqueue()
        self.assertEqual(first.action, "queued")
        self.assertEqual(second.action, "already_queued")
        self.assertEqual(len(self.store.list_github_outbox()), 1)
        link = self.store.get_github_link("bmh-group", "sandra", "vercel-production", 100)
        self.assertEqual(link["status"], "pending_create")

    def test_concurrent_enqueue_creates_one_job(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.db"
            seed = RepairStore(path, clock=lambda: 100.0)
            seed.ingest_issues(
                "bmh-group", "sandra", "vercel-production", [IssueInput(100)], cursor=None, retrieved_at=100
            )
            seed.close()
            barrier = threading.Barrier(2)
            outcomes = []

            def run():
                local = RepairStore(path, clock=lambda: 100.0)
                try:
                    barrier.wait()
                    outcomes.append(
                        enqueue_candidate(
                            local,
                            organization="bmh-group",
                            project="sandra",
                            environment="vercel-production",
                            issue_number=100,
                            now=100,
                        ).action
                    )
                finally:
                    local.close()

            threads = [threading.Thread(target=run) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            check = RepairStore(path, read_only=True)
            try:
                self.assertEqual(sorted(outcomes), ["already_queued", "queued"])
                self.assertEqual(len(check.list_github_outbox()), 1)
            finally:
                check.close()

    def test_concurrent_publishers_have_one_outbox_lease(self):
        self.enqueue()
        first = self.store.claim_github_outbox(owner="publisher-a", lease_seconds=30, now=101)
        self.assertIsNotNone(first)
        second = self.store.claim_github_outbox(owner="publisher-b", lease_seconds=30, now=101)
        self.assertIsNone(second)
        self.assertEqual(self.store.list_github_outbox()[0]["lease_owner"], "publisher-a")

    def test_lost_create_response_is_quarantined_then_marker_reconciled(self):
        self.enqueue()
        requests = []
        marker = github_payload(self.store.get_issue("bmh-group", "sandra", "vercel-production", 100))["marker"]

        def lost_opener(request, *, timeout):
            requests.append(request)
            if request.method == "GET":
                return Response({"items": []})
            raise TimeoutError("simulated lost response")

        first = GitHubPublisher(
            self.store,
            GitHubClient(token="controller-secret", opener=lost_opener),
            owner="publisher-a",
        ).publish_one(now=101)
        self.assertEqual(first.action, "create_unknown")
        self.assertEqual(self.store.list_github_outbox()[0]["status"], "create_unknown")
        self.assertEqual(self.store.get_github_link("bmh-group", "sandra", "vercel-production", 100)["status"], "create_unknown")
        self.assertTrue(all(b"controller-secret" not in request.data for request in requests if request.data))

        key = self.store.list_github_outbox()[0]["dedupe_key"]
        self.assertTrue(self.store.requeue_github_reconciliation(key, now=102))
        responses = iter([Response({"items": [{"number": 7}]}), Response(valid_issue(7, body=marker))])

        def recover_opener(request, *, timeout):
            return next(responses)

        result = GitHubPublisher(
            self.store,
            GitHubClient(token="controller-secret", opener=recover_opener),
            owner="publisher-b",
        ).publish_one(now=103)
        self.assertEqual(result.action, "reconciled")
        self.assertEqual(self.store.list_github_outbox()[0]["status"], "published")
        self.assertEqual(self.store.get_github_link("bmh-group", "sandra", "vercel-production", 100)["status"], "created")

    def test_marker_and_all_labels_must_read_back_before_existing_link_is_used(self):
        self.enqueue()
        marker = github_payload(self.store.get_issue("bmh-group", "sandra", "vercel-production", 100))["marker"]
        requests = []
        responses = iter([
            Response({"items": [{"number": 7}]}),
            Response(valid_issue(7, body=marker, labels=("sentry",))),
        ])

        def opener(request, *, timeout):
            requests.append(request)
            return next(responses)

        result = GitHubPublisher(
            self.store, GitHubClient(opener=opener), owner="publisher"
        ).publish_one(now=101)
        self.assertEqual(result.action, "reconcile_required")
        self.assertEqual(len([request for request in requests if request.method == "POST"]), 0)
        self.assertEqual(self.store.list_github_outbox()[0]["action"], "reconcile")
        self.assertEqual(self.store.get_github_link("bmh-group", "sandra", "vercel-production", 100)["status"], "readback_failed")

        # Once an operator or separate label repair supplies the required
        # labels, the same generation can be reconciled without another POST.
        responses = iter([
            Response({"items": [{"number": 7}]}),
            Response(valid_issue(7, body=marker)),
        ])
        result = GitHubPublisher(
            self.store, GitHubClient(opener=opener), owner="publisher"
        ).publish_one(now=102)
        self.assertEqual(result.action, "reconciled")

    def test_http_failures_are_classified_without_provider_body_leak(self):
        for status, expected_kind, retry_after in (
            (403, "forbidden", None),
            (422, "validation", None),
            (429, "rate_limited", 17),
        ):
            with self.subTest(status=status):
                self.enqueue()
                # Each iteration needs a fresh generation key; use a new
                # store so the test also exercises the complete lifecycle.
                self.store.close()
                self.store = RepairStore(":memory:", clock=lambda: 100.0)
                self.store.ingest_issues(
                    "bmh-group", "sandra", "vercel-production", [IssueInput(100)], cursor=None, retrieved_at=100
                )
                self.enqueue()

                def opener(request, *, timeout, status=status, retry_after=retry_after):
                    if request.method == "GET":
                        return Response({"items": []})
                    headers = {"Retry-After": str(retry_after)} if retry_after is not None else {}
                    return Response({"message": "private provider response"}, status=status, headers=headers)

                result = GitHubPublisher(
                    self.store, GitHubClient(opener=opener), owner="publisher"
                ).publish_one(now=101)
                self.assertEqual(result.action, "failed")
                self.assertEqual(result.reason, expected_kind)
                self.assertEqual(result.retry_after, retry_after)
                outbox = self.store.list_github_outbox()[0]
                self.assertEqual(outbox["status"], "failed")
                self.assertNotIn("private provider response", outbox["last_error"])
                if status == 429:
                    self.assertEqual(outbox["next_attempt_at"], 118.0)
                    self.assertIsNone(
                        GitHubPublisher(
                            self.store, GitHubClient(opener=opener), owner="publisher"
                        ).publish_one(now=110)
                    )

    def test_malformed_search_and_create_responses_fail_closed(self):
        self.enqueue()

        def malformed_search(request, *, timeout):
            return Response({"items": "not-a-list"})

        result = GitHubPublisher(
            self.store, GitHubClient(opener=malformed_search), owner="publisher"
        ).publish_one(now=101)
        self.assertEqual(result.action, "failed")
        self.assertEqual(result.reason, "malformed")

        self.store.close()
        self.store = RepairStore(":memory:", clock=lambda: 100.0)
        self.store.ingest_issues(
            "bmh-group", "sandra", "vercel-production", [IssueInput(100)], cursor=None, retrieved_at=100
        )
        self.enqueue()

        def malformed_create(request, *, timeout):
            if request.method == "GET":
                return Response({"items": []})
            return Response({"number": 7})

        result = GitHubPublisher(
            self.store, GitHubClient(opener=malformed_create), owner="publisher"
        ).publish_one(now=101)
        self.assertEqual(result.action, "create_unknown")
        self.assertEqual(self.store.list_github_outbox()[0]["status"], "create_unknown")

    def test_sanitized_payload_excludes_pii_and_untrusted_telemetry(self):
        row = self.store.get_issue("bmh-group", "sandra", "vercel-production", 100)
        payload = github_payload(row)
        encoded = json.dumps(payload, sort_keys=True)
        self.assertNotIn("customer@example.com", encoded)
        self.assertNotIn("private-caller", encoded)
        self.assertNotIn("event-private", encoded)
        self.assertNotIn("ignore this request body", encoded)
        self.assertNotIn("cron_sweep", payload["body"])
        self.assertIn("`surface`", payload["body"])
        self.enqueue()
        outbox_payload = self.store.list_github_outbox()[0]["payload_json"]
        self.assertNotIn("customer@example.com", outbox_payload)

    def test_stale_resolved_generation_is_terminalized_before_any_api_request(self):
        self.enqueue()
        original_get_issue = self.store.get_issue

        def resolve_before_read(*args, **kwargs):
            self.store.db.execute("UPDATE issues SET status='resolved' WHERE issue_number=100")
            return original_get_issue(*args, **kwargs)

        def forbidden_opener(request, *, timeout):
            raise AssertionError("stale job must not contact GitHub")

        with patch.object(self.store, "get_issue", side_effect=resolve_before_read):
            result = GitHubPublisher(
                self.store, GitHubClient(opener=forbidden_opener), owner="publisher"
            ).publish_one(now=101)
        self.assertEqual(result.action, "suppressed")
        self.assertEqual(self.store.list_github_outbox()[0]["status"], "suppressed")

    def test_generation_change_between_claim_and_readback_is_terminalized(self):
        self.enqueue()
        original_get_issue = self.store.get_issue

        def advance_generation(*args, **kwargs):
            self.store.db.execute("UPDATE issues SET generation=2 WHERE issue_number=100")
            return original_get_issue(*args, **kwargs)

        with patch.object(
            self.store,
            "get_issue",
            side_effect=advance_generation,
        ):
            result = GitHubPublisher(
                self.store,
                GitHubClient(opener=lambda request, *, timeout: (_ for _ in ()).throw(AssertionError("no API"))),
                owner="publisher",
            ).publish_one(now=101)
        self.assertEqual(result.action, "suppressed")
        self.assertIn("generation", result.reason)

    def test_status_change_immediately_before_post_is_revalidated(self):
        self.enqueue()
        marker = github_payload(self.store.get_issue("bmh-group", "sandra", "vercel-production", 100))["marker"]
        calls = []
        original_get_issue = self.store.get_issue
        reads = 0

        def resolve_on_second_read(*args, **kwargs):
            nonlocal reads
            reads += 1
            if reads == 2:
                self.store.db.execute("UPDATE issues SET status='resolved' WHERE issue_number=100")
            return original_get_issue(*args, **kwargs)

        def opener(request, *, timeout):
            calls.append(request)
            if request.method == "GET":
                return Response({"items": []})
            raise AssertionError("resolved job must not POST")

        with patch.object(self.store, "get_issue", side_effect=resolve_on_second_read):
            result = GitHubPublisher(
                self.store, GitHubClient(opener=opener), owner="publisher"
            ).publish_one(now=101)
        self.assertEqual(result.action, "suppressed")
        self.assertEqual(len([call for call in calls if call.method == "POST"]), 0)

    def test_nonproduction_claim_is_suppressed_without_api_request(self):
        self.store.close()
        self.store = RepairStore(":memory:", clock=lambda: 100.0)
        self.store.ingest_issues(
            "bmh-group", "sandra", "staging", [IssueInput(100)], cursor=None, retrieved_at=100
        )
        row = self.store.get_issue("bmh-group", "sandra", "staging", 100)
        self.store.enqueue_github_outbox(
            "bmh-group",
            "sandra",
            "staging",
            100,
            generation=1,
            repository=DEFAULT_REPOSITORY,
            dedupe_key="staging-job",
            action="create",
            payload=github_payload(row),
            now=100,
        )
        result = GitHubPublisher(
            self.store,
            GitHubClient(opener=lambda request, *, timeout: (_ for _ in ()).throw(AssertionError("no API"))),
            owner="publisher",
        ).publish_one(now=101)
        self.assertEqual(result.action, "suppressed")
        self.assertEqual(self.store.list_github_outbox()[0]["status"], "suppressed")

    def test_post_timeout_is_ambiguous_even_when_transport_error_has_no_details(self):
        self.enqueue()

        def opener(request, *, timeout):
            if request.method == "GET":
                return Response({"items": []})
            raise GitHubTransportError("transport", kind="transport", ambiguous=True)

        result = GitHubPublisher(
            self.store, GitHubClient(opener=opener), owner="publisher"
        ).publish_one(now=101)
        self.assertEqual(result.action, "create_unknown")
        self.assertNotIn("controller-secret", self.store.list_github_outbox()[0]["last_error"])

    def test_publisher_dry_run_is_read_only_and_includes_only_sanitized_preview(self):
        report = publisher_dry_run(
            self.store,
            organization="bmh-group",
            project="sandra",
            environment="vercel-production",
            issue_number=100,
        )
        self.assertEqual(report["action"], "would_create")
        self.assertIn("sentry", report["labels"])
        self.assertNotIn("customer@example.com", report["body"])
        self.assertEqual(self.store.list_github_outbox(), [])

    def test_cli_github_publish_defaults_to_read_only_dry_run(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.db"
            seed = RepairStore(path)
            seed.ingest_issues(
                "bmh-group", "sandra", "vercel-production", [IssueInput(100)], cursor=None
            )
            seed.close()
            output = StringIO()
            with redirect_stdout(output):
                exit_code = cli_main(
                    [
                        "--db",
                        str(path),
                        "github-publish",
                        "--issue",
                        "100",
                    ]
                )
            self.assertEqual(exit_code, 0)
            self.assertEqual(json.loads(output.getvalue())["action"], "would_create")
            check = RepairStore(path, read_only=True)
            try:
                self.assertEqual(check.list_github_outbox(), [])
            finally:
                check.close()

    def test_cli_rejects_mixed_repository_before_constructing_api_publisher(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.db"
            seed = RepairStore(path)
            seed.ingest_issues(
                "bmh-group", "sandra", "vercel-production", [IssueInput(100)], cursor=None
            )
            row = seed.get_issue("bmh-group", "sandra", "vercel-production", 100)
            seed.enqueue_github_outbox(
                "bmh-group",
                "sandra",
                "vercel-production",
                100,
                generation=1,
                repository=DEFAULT_REPOSITORY,
                dedupe_key="mixed-repository-job",
                action="create",
                payload=github_payload(row),
            )
            seed.close()
            with patch.dict("os.environ", {"GITHUB_TOKEN": "controller-secret"}, clear=False):
                with self.assertRaisesRegex(ValueError, "repository"):
                    cli_main(
                        [
                            "--db",
                            str(path),
                            "github-publish",
                            "--issue",
                            "100",
                            "--repository",
                            "other-owner/other-repo",
                            "--execute",
                        ]
                    )


if __name__ == "__main__":
    unittest.main()
