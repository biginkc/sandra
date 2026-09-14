"""Durable SQLite state and fencing operations for the repair controller."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping


MAX_ATTEMPTS = 2


class StateError(RuntimeError):
    """A state transition was invalid or unsafe."""


class LeaseBusy(StateError):
    """Another attempt owns the global lease."""


class ReconciliationRequired(StateError):
    """A stale lease must be reconciled explicitly before another claim."""


class FencingError(StateError):
    """A worker tried to mutate state with an old or invalid fencing token."""


@dataclass(frozen=True)
class IssueInput:
    issue_number: int
    title: str = ""
    level: str = "error"
    release: str | None = None
    event_id: str | None = None
    first_seen: str | None = None
    last_seen: str | None = None
    payload: Mapping[str, Any] | None = None
    regression_verified: bool = False
    regression_identity: str | None = None
    regression_evidence: str | None = None


@dataclass(frozen=True)
class Attempt:
    attempt_id: str
    organization: str
    project: str
    environment: str
    issue_number: int
    generation: int
    mode: str
    owner: str
    fencing_token: str
    status: str
    model: str | None
    effort: str | None
    session_id: str | None
    created_at: float
    lease_until: float
    branch: str | None = None
    worktree: str | None = None


def default_db_path() -> Path:
    """Return a user-owned durable path outside the repository."""

    state_root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return state_root / "sandra-sentry-repair" / "repair.db"


class RepairStore:
    """SQLite store with short write transactions and explicit state fencing."""

    def __init__(
        self,
        path: str | Path = ":memory:",
        *,
        clock: Callable[[], float] | None = None,
        allowed_worktree_root: str | Path | None = None,
    ) -> None:
        self.path = str(path)
        self._uri = self.path.startswith("file:")
        self.clock = clock or time.time
        self.allowed_worktree_root = (
            Path(allowed_worktree_root).expanduser().resolve()
            if allowed_worktree_root
            else None
        )
        if self.path != ":memory:":
            Path(self.path).expanduser().parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(
            self.path, timeout=10, isolation_level=None, uri=self._uri
        )
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.execute("PRAGMA busy_timeout = 10000")
        self._migrate()

    def close(self) -> None:
        self.db.close()

    def _migrate(self) -> None:
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS source_cursors (
                organization TEXT NOT NULL,
                project TEXT NOT NULL,
                environment TEXT NOT NULL,
                cursor TEXT,
                updated_at REAL NOT NULL,
                PRIMARY KEY (organization, project, environment)
            );
            CREATE TABLE IF NOT EXISTS issues (
                organization TEXT NOT NULL,
                project TEXT NOT NULL,
                environment TEXT NOT NULL,
                issue_number INTEGER NOT NULL,
                generation INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'new',
                title TEXT NOT NULL DEFAULT '',
                level TEXT NOT NULL DEFAULT 'error',
                release TEXT,
                event_id TEXT,
                first_seen TEXT,
                last_seen TEXT,
                last_seen_identity TEXT,
                last_regression_identity TEXT,
                regression_verified_at REAL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (organization, project, environment, issue_number)
            );
            CREATE TABLE IF NOT EXISTS attempts (
                attempt_id TEXT PRIMARY KEY,
                organization TEXT NOT NULL,
                project TEXT NOT NULL,
                environment TEXT NOT NULL,
                issue_number INTEGER NOT NULL,
                generation INTEGER NOT NULL,
                mode TEXT NOT NULL CHECK(mode IN ('observe','investigate','repair')),
                owner TEXT NOT NULL,
                fencing_token TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL CHECK(status IN ('leased','running','completed','failed','reconcile_required','orphaned')),
                model TEXT,
                effort TEXT,
                session_id TEXT,
                branch TEXT,
                worktree TEXT,
                prompt_hash TEXT,
                created_at REAL NOT NULL,
                lease_until REAL NOT NULL,
                finished_at REAL,
                FOREIGN KEY (organization, project, environment, issue_number)
                  REFERENCES issues(organization, project, environment, issue_number)
            );
            CREATE INDEX IF NOT EXISTS attempts_issue_generation
              ON attempts(organization, project, environment, issue_number, generation);
            CREATE TABLE IF NOT EXISTS active_lease (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id),
                fencing_token TEXT NOT NULL UNIQUE,
                lease_until REAL NOT NULL,
                owner TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pull_requests (
                attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
                number INTEGER NOT NULL,
                url TEXT NOT NULL,
                head_sha TEXT NOT NULL,
                ci_run_id TEXT,
                ci_status TEXT,
                ci_sha TEXT,
                recorded_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS deployments (
                attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
                environment TEXT NOT NULL,
                deployed_sha TEXT NOT NULL,
                provider TEXT,
                recorded_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS verifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
                kind TEXT NOT NULL,
                evidence_json TEXT NOT NULL,
                recorded_at REAL NOT NULL,
                UNIQUE(attempt_id, kind)
            );
            CREATE TABLE IF NOT EXISTS reviews (
                attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
                model TEXT NOT NULL,
                effort TEXT NOT NULL,
                session_id TEXT NOT NULL,
                decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','needs_changes')),
                evidence TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT '',
                command_json TEXT NOT NULL DEFAULT '[]',
                result_status TEXT NOT NULL DEFAULT '',
                verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
                reviewed_head_sha TEXT,
                reviewed_ci_run_id TEXT,
                reviewed_ci_sha TEXT,
                reviewed_ci_status TEXT,
                reviewed_deployed_sha TEXT,
                reviewed_functional_evidence_id TEXT,
                reviewed_functional_observed_at TEXT,
                reviewed_sentry_query_window TEXT,
                reviewed_sentry_observed_at TEXT,
                evidence_snapshot_json TEXT,
                recorded_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notifications_outbox (
                dedupe_key TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                issue_number INTEGER,
                attempt_id TEXT,
                body_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                sent_at REAL
            );
            CREATE TABLE IF NOT EXISTS scheduler_slots (
                slot_id TEXT PRIMARY KEY,
                scheduled_at REAL NOT NULL,
                claimed_at REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'claimed'
            );
            """
        )
        # Keep durable databases from the initial revision forward-compatible.
        columns = {
            row["name"]
            for row in self.db.execute("PRAGMA table_info(reviews)").fetchall()
        }
        for name, ddl in (
            ("source", "TEXT NOT NULL DEFAULT ''"),
            ("command_json", "TEXT NOT NULL DEFAULT '[]'"),
            ("result_status", "TEXT NOT NULL DEFAULT ''"),
            ("verified", "INTEGER NOT NULL DEFAULT 0"),
            ("reviewed_head_sha", "TEXT"),
            ("reviewed_ci_run_id", "TEXT"),
            ("reviewed_ci_sha", "TEXT"),
            ("reviewed_ci_status", "TEXT"),
            ("reviewed_deployed_sha", "TEXT"),
            ("reviewed_functional_evidence_id", "TEXT"),
            ("reviewed_functional_observed_at", "TEXT"),
            ("reviewed_sentry_query_window", "TEXT"),
            ("reviewed_sentry_observed_at", "TEXT"),
            ("evidence_snapshot_json", "TEXT"),
        ):
            if name not in columns:
                self.db.execute(f"ALTER TABLE reviews ADD COLUMN {name} {ddl}")
        # Legacy controller databases stored the random token itself. Convert
        # that representation once; current rows store only its digest.
        for table in ("attempts", "active_lease"):
            rows = self.db.execute(
                f"SELECT rowid, fencing_token FROM {table} WHERE length(fencing_token)=48"
            ).fetchall()
            for row in rows:
                digest = hashlib.sha256(str(row["fencing_token"]).encode("utf-8")).hexdigest()
                self.db.execute(
                    f"UPDATE {table} SET fencing_token=? WHERE rowid=?",
                    (digest, row["rowid"]),
                )

    def _now(self, now: float | None = None) -> float:
        return float(self.clock()) if now is None else float(now)

    @staticmethod
    def _fence_digest(token: str) -> str:
        if not isinstance(token, str) or not token:
            raise FencingError("fencing token is required")
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def _validate_worktree(
        self, worktree: str | Path | None, branch: str | None = None
    ) -> tuple[str, str | None]:
        if not worktree:
            raise StateError("investigate/repair attempts require an owned worktree")
        path = Path(worktree).expanduser()
        if not path.is_absolute() or not path.is_dir():
            raise StateError("worktree must be an existing absolute directory")
        resolved = path.resolve()
        if self.allowed_worktree_root is None:
            raise StateError("an owned worktree root must be configured")
        if (
            resolved != self.allowed_worktree_root
            and self.allowed_worktree_root not in resolved.parents
        ):
            raise StateError("worktree is outside the configured owned worktree root")
        # A linked worktree has a .git *file* pointing at the common Git
        # directory. A normal checkout has a .git directory and is rejected;
        # repairs must never run in the operator's main checkout.
        if not (resolved / ".git").is_file():
            raise StateError("path is not an isolated linked Git worktree")
        try:
            probe = subprocess.run(
                ["git", "-C", str(resolved), "rev-parse", "--is-inside-work-tree"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise StateError("unable to verify worktree") from exc
        if probe.returncode != 0 or probe.stdout.strip() != "true":
            raise StateError("directory is not a valid git worktree")
        actual_branch: str | None = None
        if branch:
            try:
                branch_probe = subprocess.run(
                    ["git", "-C", str(resolved), "branch", "--show-current"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise StateError("unable to verify worktree branch") from exc
            actual_branch = branch_probe.stdout.strip()
            if branch_probe.returncode != 0 or actual_branch != branch:
                raise StateError("configured branch does not match worktree")
        return str(resolved), actual_branch

    @staticmethod
    def _issue_key(
        organization: str, project: str, environment: str, issue_number: int
    ) -> tuple[str, str, str, int]:
        if not isinstance(issue_number, int) or isinstance(issue_number, bool) or issue_number <= 0:
            raise ValueError("issue_number must be a positive numeric Sentry issue id")
        return organization, project, environment, issue_number

    def get_cursor(self, organization: str, project: str, environment: str) -> str | None:
        row = self.db.execute(
            "SELECT cursor FROM source_cursors WHERE organization=? AND project=? AND environment=?",
            (organization, project, environment),
        ).fetchone()
        return None if row is None else row["cursor"]

    def ingest_issues(
        self,
        organization: str,
        project: str,
        environment: str,
        issues: Iterable[IssueInput],
        *,
        cursor: str | None,
        retrieved_at: float | None = None,
    ) -> list[dict[str, Any]]:
        """Apply one fully retrieved page set and advance its cursor atomically."""

        now = self._now(retrieved_at)
        changed: list[dict[str, Any]] = []
        self.db.execute("BEGIN IMMEDIATE")
        try:
            for item in issues:
                self._issue_key(organization, project, environment, item.issue_number)
                payload = dict(item.payload or {})
                identity = item.regression_identity or item.event_id or ":".join(
                    x for x in (item.release, item.last_seen) if x
                ) or item.title
                row = self.db.execute(
                    "SELECT * FROM issues WHERE organization=? AND project=? AND environment=? AND issue_number=?",
                    (organization, project, environment, item.issue_number),
                ).fetchone()
                generation = 1
                status = "new"
                regression = False
                if row is None:
                    self.db.execute(
                        """INSERT INTO issues(
                           organization,project,environment,issue_number,generation,status,title,level,
                           release,event_id,first_seen,last_seen,last_seen_identity,last_regression_identity,
                           regression_verified_at,payload_json,created_at,updated_at)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            organization,
                            project,
                            environment,
                            item.issue_number,
                            generation,
                            status,
                            item.title[:500],
                            item.level[:40],
                            item.release,
                            item.event_id,
                            item.first_seen,
                            item.last_seen,
                            identity,
                            identity if item.regression_verified else None,
                            now if item.regression_verified else None,
                            json.dumps(payload, sort_keys=True, separators=(",", ":")),
                            now,
                            now,
                        ),
                    )
                else:
                    generation = int(row["generation"])
                    status = str(row["status"])
                    # A poll may expose a newer last-seen event without proving
                    # a post-resolution regression. Only explicit evidence starts
                    # a new generation.
                    if (
                        status == "resolved"
                        and item.regression_verified
                        and item.regression_evidence
                        and identity
                        and identity != row["last_regression_identity"]
                    ):
                        generation += 1
                        status = "new"
                        regression = True
                    self.db.execute(
                        """UPDATE issues SET generation=?,status=?,title=?,level=?,release=?,event_id=?,
                           first_seen=COALESCE(first_seen,?),last_seen=?,last_seen_identity=?,
                           last_regression_identity=CASE WHEN ? THEN ? ELSE last_regression_identity END,
                           regression_verified_at=CASE WHEN ? THEN ? ELSE regression_verified_at END,
                           payload_json=?,updated_at=?
                           WHERE organization=? AND project=? AND environment=? AND issue_number=?""",
                        (
                            generation,
                            status,
                            item.title[:500],
                            item.level[:40],
                            item.release,
                            item.event_id,
                            item.first_seen,
                            item.last_seen,
                            identity,
                            1 if regression else 0,
                            identity,
                            1 if regression else 0,
                            now,
                            json.dumps(payload, sort_keys=True, separators=(",", ":")),
                            now,
                            organization,
                            project,
                            environment,
                            item.issue_number,
                        ),
                    )
                changed.append(
                    {
                        "issue_number": item.issue_number,
                        "generation": generation,
                        "regression_started": regression,
                    }
                )
            self.db.execute(
                """INSERT INTO source_cursors(organization,project,environment,cursor,updated_at)
                   VALUES(?,?,?,?,?) ON CONFLICT(organization,project,environment)
                   DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at""",
                (organization, project, environment, cursor, now),
            )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return changed

    def get_issue(
        self, organization: str, project: str, environment: str, issue_number: int
    ) -> dict[str, Any] | None:
        self._issue_key(organization, project, environment, issue_number)
        row = self.db.execute(
            "SELECT * FROM issues WHERE organization=? AND project=? AND environment=? AND issue_number=?",
            (organization, project, environment, issue_number),
        ).fetchone()
        return None if row is None else dict(row)

    def claim_attempt(
        self,
        organization: str,
        project: str,
        environment: str,
        issue_number: int,
        *,
        generation: int | None = None,
        owner: str,
        mode: str = "observe",
        lease_seconds: int = 900,
        now: float | None = None,
        worktree: str | Path | None = None,
        branch: str | None = None,
    ) -> Attempt | None:
        if mode not in {"observe", "investigate", "repair"}:
            raise ValueError("mode must be observe, investigate, or repair")
        if lease_seconds <= 0:
            raise ValueError("lease_seconds must be positive")
        self._issue_key(organization, project, environment, issue_number)
        if mode == "observe":
            # Observation is read-only. It deliberately consumes no lease or
            # repair attempt.
            observed = self.get_issue(organization, project, environment, issue_number)
            if observed is None:
                raise StateError("cannot observe an issue before Sentry intake")
            if generation is not None and generation != int(observed["generation"]):
                raise StateError("requested generation is not current")
            return None
        worktree_path, actual_branch = self._validate_worktree(worktree, branch)
        current = self._now(now)
        try:
            self.db.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError as exc:
            if "locked" in str(exc).lower():
                raise LeaseBusy("global lease transaction is busy") from exc
            raise
        try:
            issue = self.db.execute(
                "SELECT * FROM issues WHERE organization=? AND project=? AND environment=? AND issue_number=?",
                (organization, project, environment, issue_number),
            ).fetchone()
            if issue is None:
                raise StateError("cannot claim an issue before Sentry intake")
            selected_generation = int(issue["generation"] if generation is None else generation)
            if selected_generation != int(issue["generation"]):
                raise StateError("requested generation is not current")
            active = self.db.execute("SELECT * FROM active_lease WHERE singleton=1").fetchone()
            if active is not None:
                if float(active["lease_until"]) > current:
                    raise LeaseBusy(f"active attempt {active['attempt_id']} is leased")
                self.db.execute(
                    "UPDATE attempts SET status='reconcile_required' WHERE attempt_id=? AND status IN ('leased','running')",
                    (active["attempt_id"],),
                )
                self._enqueue_locked(
                    "stale_lease",
                    f"stale:{active['attempt_id']}",
                    {
                        "attempt_id": active["attempt_id"],
                        "owner": active["owner"],
                        "action": "reconcile_required",
                    },
                    current,
                )
                self.db.execute("COMMIT")
                raise ReconciliationRequired(
                    f"stale attempt {active['attempt_id']} requires explicit reconciliation"
                )
            count = self.db.execute(
                """SELECT COUNT(*) FROM attempts WHERE organization=? AND project=? AND environment=?
                   AND issue_number=? AND generation=?""",
                (organization, project, environment, issue_number, selected_generation),
            ).fetchone()[0]
            if int(count) >= MAX_ATTEMPTS:
                raise StateError(
                    f"attempt bound {MAX_ATTEMPTS} reached for issue {issue_number} generation {selected_generation}"
                )
            attempt_id = str(uuid.uuid4())
            fencing = secrets.token_urlsafe(32)
            fencing_digest = self._fence_digest(fencing)
            lease_until = current + lease_seconds
            self.db.execute(
                """INSERT INTO attempts(attempt_id,organization,project,environment,issue_number,generation,mode,
                   owner,fencing_token,status,branch,worktree,created_at,lease_until)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    attempt_id,
                    organization,
                    project,
                    environment,
                    issue_number,
                    selected_generation,
                    mode,
                    owner,
                    fencing_digest,
                    "leased",
                    actual_branch or branch,
                    worktree_path,
                    current,
                    lease_until,
                ),
            )
            self.db.execute(
                "INSERT INTO active_lease(singleton,attempt_id,fencing_token,lease_until,owner,created_at) VALUES(1,?,?,?,?,?)",
                (attempt_id, fencing_digest, lease_until, owner, current),
            )
            self.db.execute(
                "UPDATE issues SET status='investigating',updated_at=? WHERE organization=? AND project=? AND environment=? AND issue_number=?",
                (current, organization, project, environment, issue_number),
            )
            self.db.execute("COMMIT")
            return Attempt(
                attempt_id,
                organization,
                project,
                environment,
                issue_number,
                selected_generation,
                mode,
                owner,
                fencing,
                "leased",
                None,
                None,
                None,
                current,
                lease_until,
                actual_branch or branch,
                worktree_path,
            )
        except Exception:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise

    def _enqueue_locked(
        self, event_type: str, dedupe_key: str, body: Mapping[str, Any], now: float
    ) -> None:
        self.db.execute(
            """INSERT OR IGNORE INTO notifications_outbox(
               dedupe_key,event_type,issue_number,attempt_id,body_json,created_at)
               VALUES(?,?,?,?,?,?)""",
            (
                dedupe_key,
                event_type,
                body.get("issue_number"),
                body.get("attempt_id"),
                json.dumps(dict(body), sort_keys=True),
                now,
            ),
        )

    def _ensure_evidence_mutable_locked(self, attempt_id: str) -> None:
        review = self.db.execute(
            "SELECT decision FROM reviews WHERE attempt_id=?", (attempt_id,)
        ).fetchone()
        if review is not None and review["decision"] == "approved":
            raise StateError("approved review evidence is immutable")

    def _review_snapshot_locked(self, attempt_id: str) -> dict[str, Any]:
        """Capture the exact persisted evidence a review is allowed to approve."""

        pr = self.db.execute(
            "SELECT * FROM pull_requests WHERE attempt_id=?", (attempt_id,)
        ).fetchone()
        deployment = self.db.execute(
            "SELECT * FROM deployments WHERE attempt_id=?", (attempt_id,)
        ).fetchone()
        verification_rows = self.db.execute(
            "SELECT kind,evidence_json FROM verifications WHERE attempt_id=?",
            (attempt_id,),
        ).fetchall()
        verifications = {
            row["kind"]: json.loads(row["evidence_json"])
            for row in verification_rows
        }
        if pr is None:
            raise StateError("review requires persisted pull request and CI evidence")
        required_pr = (pr["head_sha"], pr["ci_run_id"], pr["ci_sha"], pr["ci_status"])
        if any(value in (None, "") for value in required_pr):
            raise StateError("review requires persisted pull request and CI evidence")
        if str(pr["ci_status"]).lower() not in {"success", "successful", "passed"}:
            raise StateError("review requires successful persisted CI evidence")
        if deployment is None or not deployment["deployed_sha"]:
            raise StateError("review requires persisted deployment evidence")
        functional = verifications.get("functional_probe")
        if not isinstance(functional, Mapping):
            raise StateError("review requires persisted functional probe evidence")
        if str(functional.get("status", "")).lower() not in {"pass", "passed", "success"}:
            raise StateError("review requires a passing persisted functional probe")
        functional_id = functional.get("evidence_id") or functional.get("id")
        if not str(functional_id or "").strip():
            raise StateError("review requires a functional evidence id")
        if not str(functional.get("observed_at") or "").strip():
            raise StateError("review requires functional observation timestamp")
        sentry = verifications.get("sentry_observation")
        if not isinstance(sentry, Mapping) or sentry.get("no_regression") is not True:
            raise StateError("review requires persisted Sentry no-regression evidence")
        if not str(sentry.get("query_window") or "").strip() or not str(sentry.get("observed_at") or "").strip():
            raise StateError("review requires Sentry query window and observation timestamp")
        snapshot = {
            "reviewed_head_sha": str(pr["head_sha"]),
            "reviewed_ci_run_id": str(pr["ci_run_id"]),
            "reviewed_ci_sha": str(pr["ci_sha"]),
            "reviewed_ci_status": str(pr["ci_status"]).lower(),
            "reviewed_deployed_sha": str(deployment["deployed_sha"]),
            "reviewed_functional_evidence_id": str(functional_id),
            "reviewed_functional_observed_at": functional.get("observed_at"),
            "reviewed_sentry_query_window": sentry.get("query_window"),
            "reviewed_sentry_observed_at": sentry.get("observed_at"),
            "evidence_snapshot_json": json.dumps(
                {
                    "pull_request": dict(pr),
                    "deployment": dict(deployment),
                    "verifications": verifications,
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
        }
        return snapshot

    def review_snapshot(self, attempt_id: str) -> dict[str, Any]:
        """Return current evidence for the review prompt; no state mutation."""

        return self._review_snapshot_locked(attempt_id)

    def enqueue_notification(
        self,
        event_type: str,
        dedupe_key: str,
        body: Mapping[str, Any],
        *,
        now: float | None = None,
    ) -> bool:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            before = self.db.total_changes
            self._enqueue_locked(event_type, dedupe_key, body, self._now(now))
            inserted = self.db.total_changes > before
            self.db.execute("COMMIT")
            return inserted
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def _fenced_attempt_locked(
        self, attempt_id: str, fencing_token: str, *, now: float | None = None
    ) -> sqlite3.Row:
        fencing_digest = self._fence_digest(fencing_token)
        row = self.db.execute(
            "SELECT * FROM attempts WHERE attempt_id=?", (attempt_id,)
        ).fetchone()
        active = self.db.execute(
            "SELECT * FROM active_lease WHERE singleton=1"
        ).fetchone()
        if (
            row is None
            or active is None
            or row["fencing_token"] != fencing_digest
            or active["attempt_id"] != attempt_id
            or active["fencing_token"] != fencing_digest
        ):
            raise FencingError("attempt fencing token is no longer active")
        if float(row["lease_until"]) <= self._now(now):
            raise FencingError("attempt lease has expired and requires reconciliation")
        if row["status"] not in {"leased", "running"}:
            raise FencingError(f"attempt {attempt_id} is not mutable in status {row['status']}")
        return row

    def assert_fenced(
        self, attempt_id: str, fencing_token: str, *, now: float | None = None
    ) -> None:
        """Check ownership before a worker starts any action."""

        self._fenced_attempt_locked(attempt_id, fencing_token, now=now)

    def mark_running(
        self,
        attempt_id: str,
        fencing_token: str,
        *,
        model: str,
        effort: str,
        session_id: str | None,
        prompt_hash: str | None = None,
    ) -> None:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self._fenced_attempt_locked(attempt_id, fencing_token)
            if row["status"] != "leased" or row["session_id"]:
                raise StateError("attempt has already been dispatched")
            self.db.execute(
                "UPDATE attempts SET status='running',model=?,effort=?,session_id=?,prompt_hash=? WHERE attempt_id=?",
                (model, effort, session_id, prompt_hash, attempt_id),
            )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def update_session(
        self, attempt_id: str, fencing_token: str, *, session_id: str | None
    ) -> None:
        if session_id is not None and not session_id.strip():
            raise ValueError("session_id cannot be empty")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self._fenced_attempt_locked(attempt_id, fencing_token)
            if row["session_id"] and row["session_id"] != session_id:
                raise StateError("execution session cannot be overwritten")
            self.db.execute(
                "UPDATE attempts SET session_id=? WHERE attempt_id=?",
                (session_id.strip() if session_id else None, attempt_id),
            )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def heartbeat(
        self,
        attempt_id: str,
        fencing_token: str,
        *,
        lease_seconds: int = 900,
        now: float | None = None,
    ) -> float:
        current = self._now(now)
        fencing_digest = self._fence_digest(fencing_token)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self._fenced_attempt_locked(attempt_id, fencing_token, now=current)
            existing_lease = self.db.execute(
                "SELECT lease_until FROM active_lease WHERE singleton=1 AND attempt_id=? AND fencing_token=?",
                (attempt_id, fencing_digest),
            ).fetchone()
            if existing_lease is None:
                raise FencingError("active lease disappeared")
            # A heartbeat may extend the lease, but must never shorten an
            # operator-provided lease that is already longer.
            lease_until = max(
                float(row["lease_until"]),
                float(existing_lease["lease_until"]),
                current + lease_seconds,
            )
            self.db.execute(
                "UPDATE attempts SET lease_until=? WHERE attempt_id=?",
                (lease_until, attempt_id),
            )
            self.db.execute(
                "UPDATE active_lease SET lease_until=? WHERE singleton=1 AND attempt_id=? AND fencing_token=?",
                (lease_until, attempt_id, fencing_digest),
            )
            self.db.execute("COMMIT")
            return lease_until
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def fail_attempt(
        self,
        attempt_id: str,
        fencing_token: str,
        *,
        reason: str,
        now: float | None = None,
    ) -> None:
        """Record one terminal worker failure without scheduling a retry."""

        if not reason.strip():
            raise ValueError("failure reason is required")
        current = self._now(now)
        fencing_digest = self._fence_digest(fencing_token)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._fenced_attempt_locked(attempt_id, fencing_token, now=current)
            self.db.execute(
                "UPDATE attempts SET status='failed',finished_at=? WHERE attempt_id=?",
                (current, attempt_id),
            )
            self.db.execute(
                "DELETE FROM active_lease WHERE singleton=1 AND attempt_id=? AND fencing_token=?",
                (attempt_id, fencing_digest),
            )
            self._enqueue_locked(
                "repair_failed",
                f"failed:{attempt_id}",
                {"attempt_id": attempt_id, "reason": reason.strip()},
                current,
            )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def record_pull_request(
        self,
        attempt_id: str,
        fencing_token: str,
        *,
        number: int,
        url: str,
        head_sha: str,
        ci_run_id: str | None = None,
        ci_status: str | None = None,
        ci_sha: str | None = None,
    ) -> None:
        if number <= 0 or not url or not head_sha:
            raise ValueError("PR number, URL, and head SHA are required")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._fenced_attempt_locked(attempt_id, fencing_token)
            self._ensure_evidence_mutable_locked(attempt_id)
            self.db.execute(
                """INSERT INTO pull_requests(
                   attempt_id,number,url,head_sha,ci_run_id,ci_status,ci_sha,recorded_at)
                   VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET
                   number=excluded.number,url=excluded.url,head_sha=excluded.head_sha,
                   ci_run_id=excluded.ci_run_id,ci_status=excluded.ci_status,
                   ci_sha=excluded.ci_sha,recorded_at=excluded.recorded_at""",
                (
                    attempt_id,
                    number,
                    url,
                    head_sha,
                    ci_run_id,
                    ci_status,
                    ci_sha,
                    self._now(),
                ),
            )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def record_deployment(
        self,
        attempt_id: str,
        fencing_token: str,
        *,
        environment: str,
        deployed_sha: str,
        provider: str | None = None,
    ) -> None:
        if not environment or not deployed_sha:
            raise ValueError("deployment environment and deployed SHA are required")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._fenced_attempt_locked(attempt_id, fencing_token)
            self._ensure_evidence_mutable_locked(attempt_id)
            self.db.execute(
                """INSERT INTO deployments(attempt_id,environment,deployed_sha,provider,recorded_at)
                   VALUES(?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET
                   environment=excluded.environment,deployed_sha=excluded.deployed_sha,
                   provider=excluded.provider,recorded_at=excluded.recorded_at""",
                (attempt_id, environment, deployed_sha, provider, self._now()),
            )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def record_verification(
        self,
        attempt_id: str,
        fencing_token: str,
        *,
        kind: str,
        evidence: Mapping[str, Any],
    ) -> None:
        if kind not in {"functional_probe", "sentry_observation", "ci"}:
            raise ValueError(
                "verification kind must be functional_probe, sentry_observation, or ci"
            )
        if not isinstance(evidence, Mapping) or not evidence:
            raise ValueError("verification requires evidence")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._fenced_attempt_locked(attempt_id, fencing_token)
            self._ensure_evidence_mutable_locked(attempt_id)
            self.db.execute(
                """INSERT INTO verifications(attempt_id,kind,evidence_json,recorded_at)
                   VALUES(?,?,?,?) ON CONFLICT(attempt_id,kind) DO UPDATE SET
                   evidence_json=excluded.evidence_json,recorded_at=excluded.recorded_at""",
                (attempt_id, kind, json.dumps(dict(evidence), sort_keys=True), self._now()),
            )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def record_review(
        self,
        attempt_id: str,
        fencing_token: str,
        *,
        model: str,
        effort: str,
        session_id: str,
        decision: str,
        evidence: str,
        source: str | None = None,
        command: list[str] | None = None,
        result_status: str | None = None,
        verified: bool = False,
        snapshot: Mapping[str, Any] | None = None,
    ) -> None:
        if model != "gpt-6-astra" or effort != "medium":
            raise ValueError("independent Astra medium review is required")
        if (
            decision not in {"approved", "rejected", "needs_changes"}
            or not session_id
            or not evidence.strip()
        ):
            raise ValueError("review requires a decision, independent session, and evidence")
        if not verified or source != "codex_exec" or result_status not in {"success", "passed"}:
            raise ValueError("review must come from a verified codex exec result")
        if (
            not isinstance(command, list)
            or command[:3] != ["codex", "exec", "--model"]
            or "gpt-6-astra" not in command
        ):
            raise ValueError("review command must explicitly run Astra through codex exec")
        if 'model_reasoning_effort="medium"' not in command:
            raise ValueError("review command must explicitly use medium reasoning effort")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self._fenced_attempt_locked(attempt_id, fencing_token)
            if row["session_id"] and row["session_id"] == session_id:
                raise ValueError("review session must be independent from repair session")
            existing_review = self.db.execute(
                "SELECT decision FROM reviews WHERE attempt_id=?", (attempt_id,)
            ).fetchone()
            if existing_review is not None and existing_review["decision"] == "approved":
                raise StateError("approved review cannot be replaced")
            reviewed = self._review_snapshot_locked(attempt_id)
            if snapshot is not None and any(
                snapshot.get(key) != reviewed.get(key)
                for key in reviewed
            ):
                raise StateError("review evidence changed while the review was running")
            self.db.execute(
                """INSERT INTO reviews(attempt_id,model,effort,session_id,decision,evidence,source,
                   command_json,result_status,verified,reviewed_head_sha,reviewed_ci_run_id,
                   reviewed_ci_sha,reviewed_ci_status,reviewed_deployed_sha,
                   reviewed_functional_evidence_id,reviewed_functional_observed_at,
                   reviewed_sentry_query_window,reviewed_sentry_observed_at,
                   evidence_snapshot_json,recorded_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET
                   model=excluded.model,effort=excluded.effort,session_id=excluded.session_id,
                   decision=excluded.decision,evidence=excluded.evidence,source=excluded.source,
                   command_json=excluded.command_json,result_status=excluded.result_status,
                   verified=excluded.verified,reviewed_head_sha=excluded.reviewed_head_sha,
                   reviewed_ci_run_id=excluded.reviewed_ci_run_id,reviewed_ci_sha=excluded.reviewed_ci_sha,
                   reviewed_ci_status=excluded.reviewed_ci_status,reviewed_deployed_sha=excluded.reviewed_deployed_sha,
                   reviewed_functional_evidence_id=excluded.reviewed_functional_evidence_id,
                   reviewed_functional_observed_at=excluded.reviewed_functional_observed_at,
                   reviewed_sentry_query_window=excluded.reviewed_sentry_query_window,
                   reviewed_sentry_observed_at=excluded.reviewed_sentry_observed_at,
                   evidence_snapshot_json=excluded.evidence_snapshot_json,recorded_at=excluded.recorded_at""",
                (
                    attempt_id,
                    model,
                    effort,
                    session_id,
                    decision,
                    evidence.strip(),
                    source,
                    json.dumps(command, separators=(",", ":")),
                    result_status,
                    1,
                    reviewed["reviewed_head_sha"],
                    reviewed["reviewed_ci_run_id"],
                    reviewed["reviewed_ci_sha"],
                    reviewed["reviewed_ci_status"],
                    reviewed["reviewed_deployed_sha"],
                    reviewed["reviewed_functional_evidence_id"],
                    reviewed["reviewed_functional_observed_at"],
                    reviewed["reviewed_sentry_query_window"],
                    reviewed["reviewed_sentry_observed_at"],
                    reviewed["evidence_snapshot_json"],
                    self._now(),
                ),
            )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def reconcile_stale_lease(
        self,
        attempt_id: str,
        *,
        outcome: str,
        evidence: str,
        now: float | None = None,
    ) -> None:
        """Explicitly fence an expired worker before allowing a new claim."""

        if outcome not in {"abandoned", "failed"}:
            raise ValueError("outcome must be abandoned or failed")
        if not evidence.strip():
            raise ValueError("reconciliation requires evidence")
        current = self._now(now)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            active = self.db.execute(
                "SELECT * FROM active_lease WHERE singleton=1"
            ).fetchone()
            if active is None or active["attempt_id"] != attempt_id:
                raise StateError("attempt is not the active stale lease")
            attempt = self.db.execute(
                "SELECT * FROM attempts WHERE attempt_id=?", (attempt_id,)
            ).fetchone()
            if attempt is None or float(active["lease_until"]) > current:
                raise StateError("attempt is not stale")
            self.db.execute(
                "UPDATE attempts SET status=?,finished_at=? WHERE attempt_id=?",
                ("orphaned" if outcome == "abandoned" else "failed", current, attempt_id),
            )
            self.db.execute(
                "DELETE FROM active_lease WHERE singleton=1 AND attempt_id=?",
                (attempt_id,),
            )
            self._enqueue_locked(
                "reconciled_stale_lease",
                f"reconciled:{attempt_id}",
                {"attempt_id": attempt_id, "outcome": outcome, "evidence": evidence.strip()},
                current,
            )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def completion_context(self, attempt_id: str) -> dict[str, Any]:
        attempt = self.db.execute(
            "SELECT * FROM attempts WHERE attempt_id=?", (attempt_id,)
        ).fetchone()
        if attempt is None:
            raise StateError("unknown attempt")
        pr = self.db.execute(
            "SELECT * FROM pull_requests WHERE attempt_id=?", (attempt_id,)
        ).fetchone()
        deployment = self.db.execute(
            "SELECT * FROM deployments WHERE attempt_id=?", (attempt_id,)
        ).fetchone()
        verifications = {
            row["kind"]: json.loads(row["evidence_json"])
            for row in self.db.execute(
                "SELECT kind,evidence_json FROM verifications WHERE attempt_id=?",
                (attempt_id,),
            )
        }
        review = self.db.execute(
            "SELECT * FROM reviews WHERE attempt_id=?", (attempt_id,)
        ).fetchone()
        issue = self.get_issue(
            attempt["organization"],
            attempt["project"],
            attempt["environment"],
            attempt["issue_number"],
        )
        return {
            "attempt": dict(attempt),
            "issue": issue,
            "pull_request": None if pr is None else dict(pr),
            "deployment": None if deployment is None else dict(deployment),
            "verifications": verifications,
            "review": None if review is None else dict(review),
        }

    def complete_attempt(
        self,
        attempt_id: str,
        fencing_token: str,
        record: Mapping[str, Any],
        *,
        now: float | None = None,
    ) -> None:
        from validation import validate_completion_record

        current = self._now(now)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            attempt = self._fenced_attempt_locked(attempt_id, fencing_token, now=current)
            context = self.completion_context(attempt_id)
            validate_completion_record(record, context)
            self.db.execute(
                "UPDATE attempts SET status='completed',finished_at=? WHERE attempt_id=?",
                (current, attempt_id),
            )
            self.db.execute(
                "DELETE FROM active_lease WHERE singleton=1 AND attempt_id=? AND fencing_token=?",
                (attempt_id, self._fence_digest(fencing_token)),
            )
            self.db.execute(
                """UPDATE issues SET status='resolved',updated_at=?
                   WHERE organization=? AND project=? AND environment=? AND issue_number=? AND generation=?""",
                (
                    current,
                    attempt["organization"],
                    attempt["project"],
                    attempt["environment"],
                    attempt["issue_number"],
                    attempt["generation"],
                ),
            )
            self._enqueue_locked(
                "repair_completed",
                f"completed:{attempt_id}",
                {
                    "attempt_id": attempt_id,
                    "issue_number": attempt["issue_number"],
                    "generation": attempt["generation"],
                },
                current,
            )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def claim_scheduler_slot(
        self, slot_id: str, scheduled_at: float, *, now: float | None = None
    ) -> bool:
        current = self._now(now)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            before = self.db.total_changes
            self.db.execute(
                "INSERT OR IGNORE INTO scheduler_slots(slot_id,scheduled_at,claimed_at) VALUES(?,?,?)",
                (slot_id, scheduled_at, current),
            )
            claimed = self.db.total_changes > before
            self.db.execute("COMMIT")
            return claimed
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def list_outbox(self) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self.db.execute(
                "SELECT * FROM notifications_outbox ORDER BY created_at, dedupe_key"
            )
        ]
