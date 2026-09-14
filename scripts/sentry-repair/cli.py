#!/usr/bin/env python3
"""Operator CLI for the bounded Sandra Sentry repair controller.

Examples:
  cli.py --db /path/state.db intake
  cli.py --db /path/state.db --worktree-root /owned/_codex_worktrees claim \
      --issue 123 --owner worker --mode investigate --worktree /owned/_codex_worktrees/job
  SANDRA_FENCING_TOKEN=TOKEN cli.py --db /path/state.db dispatch --attempt-id ID

Dispatch is a dry-run unless --execute is explicitly supplied. This CLI never
sends the notification outbox to Slack and never installs a scheduler.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# A hyphenated directory is intentionally runnable as a script. Keep imports
# local to this directory and stdlib-only.
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from dispatch import SubprocessExecutor, dispatch_attempt, dispatch_review  # noqa: E402
from github import github_dry_run  # noqa: E402
from github_publisher import (  # noqa: E402
    DEFAULT_REPOSITORY,
    GitHubClient,
    GitHubPublisher,
    enqueue_candidate,
    publisher_dry_run,
)
from schedule import due_slot  # noqa: E402
from sentry import SentryClient, SentryConfig, intake_from_sentry, numeric_issue_key  # noqa: E402
from store import IssueInput, RepairStore, default_db_path  # noqa: E402


def _json_file(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _add_fencing_input(command: argparse.ArgumentParser) -> None:
    command.add_argument(
        "--fencing-token-file",
        help="file containing the controller fencing token (keeps it out of argv)",
    )
    command.add_argument(
        "--fencing-token-env",
        default="SANDRA_FENCING_TOKEN",
        help="environment variable containing the controller fencing token",
    )


def _fencing_token(args: argparse.Namespace) -> str:
    if args.fencing_token_file:
        token = Path(args.fencing_token_file).expanduser().read_text(encoding="utf-8").strip()
    else:
        token = os.environ.get(args.fencing_token_env, "").strip()
    if not token:
        raise ValueError("provide a fencing token through --fencing-token-file or the configured environment variable")
    return token


def _parse_at(value: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("--at must include a timezone")
    return parsed


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Sandra bounded Sentry repair controller")
    root.add_argument("--db", default=str(default_db_path()), help="durable SQLite path")
    root.add_argument(
        "--worktree-root",
        default=os.environ.get("SANDRA_REPAIR_WORKTREE_ROOT"),
        help="owned worktree parent; required for investigate/repair claims (or SANDRA_REPAIR_WORKTREE_ROOT)",
    )
    sub = root.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="create/migrate the durable state database")

    intake = sub.add_parser("intake", help="retrieve Sentry pages and commit them atomically")
    intake.add_argument("--issues-file", help="offline JSON fixture with {issues:[...], cursor:...}")
    intake.add_argument("--retrieved-at", type=float)

    claim = sub.add_parser("claim", help="claim one bounded global attempt")
    claim.add_argument("--issue", type=int, required=True)
    claim.add_argument("--owner", required=True)
    claim.add_argument("--mode", choices=("observe", "investigate", "repair"), default="observe")
    claim.add_argument("--generation", type=int)
    claim.add_argument("--lease-seconds", type=int, default=900)
    claim.add_argument("--worktree", help="existing owned git worktree (required outside observe mode)")
    claim.add_argument("--branch", help="optional exact branch name to verify")

    reconcile = sub.add_parser("reconcile", help="explicitly fence an expired lease")
    reconcile.add_argument("--attempt-id", required=True)
    reconcile.add_argument("--outcome", choices=("abandoned", "failed"), required=True)
    reconcile.add_argument("--evidence", required=True)

    finish_investigation = sub.add_parser(
        "finish-investigation",
        help="explicitly finish a successful read-only investigation and release its lease",
    )
    finish_investigation.add_argument("--attempt-id", required=True)
    _add_fencing_input(finish_investigation)
    finish_investigation.add_argument("--evidence", required=True)

    fail = sub.add_parser("fail", help="explicitly terminalize a failed or rejected repair")
    fail.add_argument("--attempt-id", required=True)
    _add_fencing_input(fail)
    fail.add_argument("--reason", required=True)

    heartbeat = sub.add_parser("heartbeat", help="extend one active lease without shortening it")
    heartbeat.add_argument("--attempt-id", required=True)
    _add_fencing_input(heartbeat)
    heartbeat.add_argument("--lease-seconds", type=int, default=900)

    dispatch = sub.add_parser("dispatch", help="plan or explicitly run one bounded Codex attempt")
    dispatch.add_argument("--attempt-id", required=True)
    _add_fencing_input(dispatch)
    dispatch.add_argument("--spark-effort", choices=("low", "medium"), default="low")
    dispatch.add_argument("--timeout-seconds", type=int, default=900)
    dispatch.add_argument("--heartbeat-interval-seconds", type=int, default=30)
    dispatch.add_argument("--execute", action="store_true", help="perform the codex exec after preflight")

    pr = sub.add_parser("record-pr", help="persist PR and actual CI evidence")
    pr.add_argument("--attempt-id", required=True)
    _add_fencing_input(pr)
    pr.add_argument("--number", type=int, required=True)
    pr.add_argument("--url", required=True)
    pr.add_argument("--head-sha", required=True)
    pr.add_argument("--ci-run-id")
    pr.add_argument("--ci-status")
    pr.add_argument("--ci-sha")

    dep = sub.add_parser("record-deployment", help="persist deployed commit evidence")
    dep.add_argument("--attempt-id", required=True)
    _add_fencing_input(dep)
    dep.add_argument("--environment", required=True)
    dep.add_argument("--deployed-sha", required=True)
    dep.add_argument("--provider")

    ver = sub.add_parser("record-verification", help="persist functional/Sentry evidence JSON")
    ver.add_argument("--attempt-id", required=True)
    _add_fencing_input(ver)
    ver.add_argument("--kind", choices=("functional_probe", "sentry_observation", "ci"), required=True)
    ver.add_argument("--evidence-file", required=True)

    review_run = sub.add_parser("review", help="plan or run the independent Astra medium gate")
    review_run.add_argument("--attempt-id", required=True)
    _add_fencing_input(review_run)
    review_run.add_argument("--timeout-seconds", type=int, default=600)
    review_run.add_argument("--execute", action="store_true", help="run codex exec and parse its actual review record")

    review = sub.add_parser("record-review", help="disabled manual write; review must come from codex exec")
    review.add_argument("--attempt-id", required=True)
    _add_fencing_input(review)
    review.add_argument("--session-id", required=True)
    review.add_argument("--decision", choices=("approved", "rejected", "needs_changes"), required=True)
    review.add_argument("--evidence", required=True)

    complete = sub.add_parser("complete", help="validate exact completion evidence and close attempt")
    complete.add_argument("--attempt-id", required=True)
    _add_fencing_input(complete)
    complete.add_argument("--record-file", required=True)

    slot = sub.add_parser("schedule", help="claim one due schedule slot (no scheduler is installed)")
    slot.add_argument("--at", required=True, help="timezone-aware ISO timestamp")

    sub.add_parser("outbox", help="show deduplicated notifications (no sending)")

    github_dry_run_command = sub.add_parser(
        "github-dry-run",
        help="render a sanitized GitHub-incident proposal without any network or state mutation",
    )
    github_dry_run_command.add_argument("--issue", type=int, required=True)
    github_publish = sub.add_parser(
        "github-publish",
        help="preview or explicitly publish one sanitized GitHub issue (dry-run by default)",
    )
    github_publish.add_argument("--issue", type=int, required=True)
    github_publish.add_argument(
        "--repository",
        default=os.environ.get("SANDRA_GITHUB_REPOSITORY", DEFAULT_REPOSITORY),
    )
    github_publish.add_argument(
        "--owner",
        default=os.environ.get("SANDRA_GITHUB_PUBLISHER_OWNER", "sandra-controller"),
    )
    github_publish.add_argument(
        "--token-env",
        default="GITHUB_TOKEN",
        help="environment variable containing the controller-only GitHub token",
    )
    github_publish.add_argument("--timeout-seconds", type=int, default=20)
    github_publish.add_argument(
        "--execute", action="store_true", help="enqueue and perform the GitHub API operation"
    )
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "claim" and args.mode != "observe" and not args.worktree_root:
        raise ValueError("--worktree-root or SANDRA_REPAIR_WORKTREE_ROOT is required for repair claims")
    store = RepairStore(
        args.db,
        allowed_worktree_root=args.worktree_root,
        # A dry run must neither initialize nor migrate durable state.  An
        # absent or unreadable database is therefore a fail-closed error.
        read_only=args.command == "github-dry-run"
        or (args.command == "github-publish" and not args.execute),
    )
    try:
        if args.command == "init":
            print(json.dumps({"db": str(Path(args.db).expanduser())}))
            return 0
        if args.command == "intake":
            if args.issues_file:
                fixture = _json_file(args.issues_file)
                if not isinstance(fixture, dict) or not isinstance(fixture.get("issues"), list):
                    raise ValueError("fixture must be an object with an issues array")
                config = SentryConfig()
                items = []
                for raw in fixture["issues"]:
                    if not isinstance(raw, dict):
                        raise ValueError("fixture issue must be an object")
                    items.append(
                        IssueInput(
                            issue_number=numeric_issue_key(raw["issue_number"]),
                            title=str(raw.get("title", "")),
                            level=str(raw.get("level", "error")),
                            release=raw.get("release"),
                            event_id=raw.get("event_id"),
                            first_seen=raw.get("first_seen"),
                            last_seen=raw.get("last_seen"),
                            payload=raw.get("payload", {}),
                            regression_verified=bool(raw.get("regression_verified", False)),
                            regression_identity=raw.get("regression_identity"),
                            regression_evidence=raw.get("regression_evidence"),
                        )
                    )
                changed = store.ingest_issues(
                    config.organization,
                    config.project,
                    config.environment,
                    items,
                    cursor=fixture.get("cursor"),
                    retrieved_at=args.retrieved_at,
                )
            else:
                token = os.environ.get("SENTRY_AUTH_TOKEN")
                if not token:
                    raise ValueError("SENTRY_AUTH_TOKEN is required for live intake")
                changed = intake_from_sentry(store, SentryClient(token=token), retrieved_at=args.retrieved_at)
            print(json.dumps({"changed": changed}, sort_keys=True))
            return 0
        if args.command == "claim":
            attempt = store.claim_attempt(
                SentryConfig().organization,
                SentryConfig().project,
                SentryConfig().environment,
                args.issue,
                generation=args.generation,
                owner=args.owner,
                mode=args.mode,
                lease_seconds=args.lease_seconds,
                worktree=args.worktree,
                branch=args.branch,
            )
            print(json.dumps(None if attempt is None else attempt.__dict__, sort_keys=True))
            return 0
        if args.command == "reconcile":
            store.reconcile_stale_lease(
                args.attempt_id, outcome=args.outcome, evidence=args.evidence
            )
            print(json.dumps({"reconciled": args.attempt_id}))
            return 0
        if args.command == "finish-investigation":
            store.finish_investigation(
                args.attempt_id, _fencing_token(args), evidence=args.evidence
            )
            print(json.dumps({"investigation_finished": args.attempt_id}))
            return 0
        if args.command == "fail":
            store.fail_attempt(
                args.attempt_id, _fencing_token(args), reason=args.reason
            )
            print(json.dumps({"failed": args.attempt_id}))
            return 0
        if args.command == "heartbeat":
            lease_until = store.heartbeat(
                args.attempt_id,
                _fencing_token(args),
                lease_seconds=args.lease_seconds,
            )
            print(json.dumps({"attempt_id": args.attempt_id, "lease_until": lease_until}))
            return 0
        if args.command == "dispatch":
            result = dispatch_attempt(
                store,
                args.attempt_id,
                _fencing_token(args),
                executor=SubprocessExecutor(fencing_env_name=args.fencing_token_env),
                spark_effort=args.spark_effort,
                timeout_seconds=args.timeout_seconds,
                heartbeat_interval_seconds=args.heartbeat_interval_seconds,
                execute=args.execute,
            )
            print(json.dumps(result, sort_keys=True))
            return 0
        if args.command == "review":
            result = dispatch_review(
                store,
                args.attempt_id,
                _fencing_token(args),
                executor=SubprocessExecutor(fencing_env_name=args.fencing_token_env),
                timeout_seconds=args.timeout_seconds,
                execute=args.execute,
            )
            print(json.dumps(result, sort_keys=True))
            return 0
        if args.command == "record-pr":
            store.record_pull_request(
                args.attempt_id,
                _fencing_token(args),
                number=args.number,
                url=args.url,
                head_sha=args.head_sha,
                ci_run_id=args.ci_run_id,
                ci_status=args.ci_status,
                ci_sha=args.ci_sha,
            )
            return 0
        if args.command == "record-deployment":
            store.record_deployment(
                args.attempt_id,
                _fencing_token(args),
                environment=args.environment,
                deployed_sha=args.deployed_sha,
                provider=args.provider,
            )
            return 0
        if args.command == "record-verification":
            evidence = _json_file(args.evidence_file)
            store.record_verification(
                args.attempt_id, _fencing_token(args), kind=args.kind, evidence=evidence
            )
            return 0
        if args.command == "record-review":
            raise ValueError("manual review writes are disabled; use review --execute")
        if args.command == "complete":
            record = _json_file(args.record_file)
            store.complete_attempt(args.attempt_id, _fencing_token(args), record)
            print(json.dumps({"completed": args.attempt_id}))
            return 0
        if args.command == "schedule":
            at = _parse_at(args.at)
            result = due_slot(at, store)
            print(json.dumps(None if result is None else {"slot_id": result[0], "slot_utc": result[1].isoformat()}))
            return 0
        if args.command == "outbox":
            print(json.dumps(store.list_outbox(), sort_keys=True))
            return 0
        if args.command == "github-dry-run":
            report = github_dry_run(
                store,
                SentryConfig().organization,
                SentryConfig().project,
                SentryConfig().environment,
                args.issue,
            )
            print(json.dumps(report.__dict__, sort_keys=True))
            return 0
        if args.command == "github-publish":
            config = SentryConfig()
            if not args.execute:
                report = publisher_dry_run(
                    store,
                    organization=config.organization,
                    project=config.project,
                    environment=config.environment,
                    issue_number=args.issue,
                    repository=args.repository,
                )
                print(json.dumps(report, sort_keys=True))
                return 0
            existing_jobs = store.list_github_outbox_for_source(
                config.organization,
                config.project,
                config.environment,
                args.issue,
            )
            if any(str(job["repository"]) != args.repository for job in existing_jobs):
                raise ValueError("--repository does not match the issue's claimed GitHub outbox")
            token = os.environ.get(args.token_env)
            if not token:
                raise ValueError(f"{args.token_env} is required for explicit GitHub publishing")
            queued = enqueue_candidate(
                store,
                organization=config.organization,
                project=config.project,
                environment=config.environment,
                issue_number=args.issue,
                repository=args.repository,
            )
            if queued.action in {"suppressed", "linked"}:
                print(json.dumps(queued.as_dict(), sort_keys=True))
                return 0
            result = GitHubPublisher(
                store,
                GitHubClient(
                    repository=args.repository,
                    token=token,
                    timeout_seconds=args.timeout_seconds,
                ),
                owner=args.owner,
                dedupe_key=queued.dedupe_key,
            ).publish_one()
            print(json.dumps(None if result is None else result.as_dict(), sort_keys=True))
            return 0
        raise AssertionError(args.command)
    finally:
        store.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)
