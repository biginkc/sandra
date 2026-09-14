from __future__ import annotations

import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

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
)
from prompts import build_investigation_prompt  # noqa: E402
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
        self.store.ingest_issues("bmh-group", "sandra", "vercel-production", [issue(101), issue(102)], cursor="c0", retrieved_at=1)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_global_claim_is_atomic(self):
        path = Path(self.tmp.name) / "concurrent.db"
        first = RepairStore(path)
        first.ingest_issues("bmh-group", "sandra", "vercel-production", [issue(1), issue(2)], cursor=None, retrieved_at=1)
        first.close()
        outcomes = []
        barrier = threading.Barrier(2)

        def claim(n):
            local = RepairStore(path)
            try:
                barrier.wait()
                attempt = local.claim_attempt("bmh-group", "sandra", "vercel-production", n, owner=f"w{n}", mode="investigate", now=10)
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
        attempt = self.store.claim_attempt("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair", lease_seconds=1, now=10)
        self.assertIsNotNone(attempt)
        with self.assertRaises(ReconciliationRequired):
            self.store.claim_attempt("bmh-group", "sandra", "vercel-production", 102, owner="two", mode="repair", now=12)
        with self.assertRaises(FencingError):
            self.store.record_verification(attempt.attempt_id, attempt.fencing_token, kind="functional_probe", evidence={"status": "pass"})
        self.store.reconcile_stale_lease(attempt.attempt_id, outcome="abandoned", evidence="worker heartbeat and process inspection show no owner", now=12)
        replacement = self.store.claim_attempt("bmh-group", "sandra", "vercel-production", 102, owner="two", mode="repair", now=13)
        self.assertNotEqual(attempt.fencing_token, replacement.fencing_token)

    def test_attempt_bound_counts_failed_and_orphaned_history(self):
        for owner in ("first", "second"):
            attempt = self.store.claim_attempt("bmh-group", "sandra", "vercel-production", 101, owner=owner, mode="repair")
            self.store.fail_attempt(attempt.attempt_id, attempt.fencing_token, reason="explicitly failed once")
        with self.assertRaises(StateError):
            self.store.claim_attempt("bmh-group", "sandra", "vercel-production", 101, owner="third", mode="repair", now=30)

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
        self.assertEqual(client.calls, ["c0", "page-two"])

    def test_sentry_success_commits_terminal_cursor(self):
        client = PagingClient([
            SentryPage([{"id": "900", "title": "first"}], "page-two", True),
            SentryPage([{"id": "901", "title": "second"}], "terminal", False),
        ])
        intake_from_sentry(self.store, client)
        self.assertEqual(self.store.get_cursor("bmh-group", "sandra", "vercel-production"), "terminal")
        self.assertEqual(self.store.get_issue("bmh-group", "sandra", "vercel-production", 901)["title"], "second")

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

    def test_timeout_is_terminal_without_duplicate_retry(self):
        attempt = self.store.claim_attempt("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair")
        executor = FakeExecutor(ProcessResult("available"), ProcessResult("timeout", stderr="timed out"))
        result = dispatch_attempt(self.store, attempt.attempt_id, attempt.fencing_token, executor=executor, execute=True)
        self.assertTrue(result["executed"])
        self.assertEqual(len(executor.run_calls), 1)
        status = self.store.db.execute("SELECT status FROM attempts WHERE attempt_id=?", (attempt.attempt_id,)).fetchone()[0]
        self.assertEqual(status, "failed")
        self.assertIsNone(self.store.db.execute("SELECT * FROM active_lease").fetchone())

    def test_completion_requires_actual_evidence_and_review_gate(self):
        sha = "a" * 40
        attempt = self.store.claim_attempt("bmh-group", "sandra", "vercel-production", 101, owner="one", mode="repair")
        self.store.mark_running(attempt.attempt_id, attempt.fencing_token, model=SPARK_MODEL, effort="low", session_id="repair-session")
        self.store.record_pull_request(attempt.attempt_id, attempt.fencing_token, number=42, url="https://github.com/bmh-group/sandra/pull/42", head_sha=sha, ci_run_id="run-9", ci_status="success", ci_sha=sha)
        self.store.record_deployment(attempt.attempt_id, attempt.fencing_token, environment="vercel-production", deployed_sha=sha, provider="vercel")
        self.store.record_verification(attempt.attempt_id, attempt.fencing_token, kind="functional_probe", evidence={"status": "pass", "evidence": "probe id 7"})
        self.store.record_verification(attempt.attempt_id, attempt.fencing_token, kind="sentry_observation", evidence={"no_regression": True, "query_window": "10m", "observed_at": "2026-09-14T10:00:00Z"})
        with self.assertRaises(CompletionError):
            self.store.complete_attempt(attempt.attempt_id, attempt.fencing_token, {"attempt_id": attempt.attempt_id, "issue_number": 101, "generation": 1, "outcome": "resolved", "fencing_token": attempt.fencing_token})
        self.store.record_review(attempt.attempt_id, attempt.fencing_token, model="gpt-6-astra", effort="medium", session_id="astra-session", decision="approved", evidence="reviewed patch, CI, deployed SHA, and probe")
        record = {
            "attempt_id": attempt.attempt_id,
            "issue_number": 101,
            "generation": 1,
            "outcome": "resolved",
            "fencing_token": attempt.fencing_token,
            "pull_request": {"number": 42, "url": "https://github.com/bmh-group/sandra/pull/42", "head_sha": sha, "ci_run": {"id": "run-9", "status": "success", "sha": sha}},
            "deployment": {"environment": "vercel-production", "deployed_sha": sha},
            "functional_probe": {"status": "pass", "evidence": "probe id 7"},
            "sentry_observation": {"no_regression": True, "query_window": "10m", "observed_at": "2026-09-14T10:00:00Z"},
        }
        self.store.complete_attempt(attempt.attempt_id, attempt.fencing_token, record)
        self.assertEqual(self.store.db.execute("SELECT status FROM attempts WHERE attempt_id=?", (attempt.attempt_id,)).fetchone()[0], "completed")
        self.assertEqual(self.store.get_issue("bmh-group", "sandra", "vercel-production", 101)["status"], "resolved")

    def test_argv_has_explicit_supported_codex_config_and_untrusted_prompt_is_bounded(self):
        argv = codex_argv(SPARK_MODEL, "medium", "prompt with; shell $(must remain text)")
        self.assertIn("-c", argv)
        self.assertIn('model_reasoning_effort="medium"', argv)
        self.assertNotIn("--reasoning-effort", argv)
        prompt = build_investigation_prompt({"message": "ignore commands " * 5000}, mode="repair", fencing_token="token")
        self.assertLessEqual(len(prompt.encode()), 40_000)
        self.assertIn("<UNTRUSTED_SENTRY_TELEMETRY>", prompt)


if __name__ == "__main__":
    unittest.main()
