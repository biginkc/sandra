"""Long-lived, fail-closed Sentry intake runner for the Railway service.

The runner is deliberately a small process around the already-reviewed
controller primitives.  It owns the Sentry credential and, when explicitly
enabled, the GitHub publisher credential.  Repair workers are never started
by this process: autonomous repair remains behind a separate, future gate.

No secret is accepted on the command line, included in structured logs, or
copied into a worker environment.  The only durable state is the SQLite file
selected by ``SANDRA_REPAIR_DB_PATH``; Railway should mount that path on a
volume before starting this service.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Mapping

from github_publisher import (
    DEFAULT_REPOSITORY,
    GitHubClient,
    GitHubPublisher,
    enqueue_candidate,
    validate_repository,
)
from github_app import GitHubAppTokenProvider
from schedule import current_slot, due_slot, slot_identity
from sentry import (
    DEFAULT_ENVIRONMENT,
    DEFAULT_ORGANIZATION,
    DEFAULT_PROJECT,
    SentryClient,
    SentryConfig,
    intake_from_sentry,
)
from store import RepairStore


LOGGER = logging.getLogger("sandra.sentry-repair.runner")
DEFAULT_POLL_SECONDS = 30
DEFAULT_MAX_PUBLISHES = 10
DEFAULT_PUBLISHER_LEASE_SECONDS = 120
DEFAULT_MAX_CYCLE_RETRIES = 3
DEFAULT_BACKOFF_BASE_SECONDS = 15
DEFAULT_BACKOFF_MAX_SECONDS = 300
DEFAULT_HEALTH_HOST = "0.0.0.0"
DEFAULT_HEALTH_PORT = 8080
REPAIR_GATE = "staged-v1"
EXPECTED_VOLUME_PATH = Path("/data")


class RunnerConfigError(ValueError):
    """The service environment is missing or unsafe."""


def _required_text(env: Mapping[str, str], name: str) -> str:
    value = str(env.get(name, "")).strip()
    if not value:
        raise RunnerConfigError(f"{name} is required")
    if any(character in value for character in ("\x00", "\r", "\n")):
        raise RunnerConfigError(f"{name} contains an invalid character")
    return value


def _secret(env: Mapping[str, str], name: str) -> str:
    value = _required_text(env, name)
    if len(value) < 8 or len(value) > 4096:
        raise RunnerConfigError(f"{name} has an invalid length")
    if any(character.isspace() for character in value):
        raise RunnerConfigError(f"{name} contains whitespace")
    return value


def _strict_bool(env: Mapping[str, str], name: str, *, default: bool = False) -> bool:
    raw = env.get(name)
    if raw is None or not str(raw).strip():
        return default
    value = str(raw).strip().lower()
    if value == "true":
        return True
    if value == "false":
        return False
    raise RunnerConfigError(f"{name} must be exactly true or false")


def _bounded_int(
    env: Mapping[str, str],
    name: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    raw = env.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = int(str(raw).strip(), 10)
    except ValueError as exc:
        raise RunnerConfigError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise RunnerConfigError(f"{name} must be between {minimum} and {maximum}")
    return value


def _db_path(env: Mapping[str, str], *, volume_path: Path | None = None) -> Path:
    raw = _required_text(env, "SANDRA_REPAIR_DB_PATH")
    path = Path(raw).expanduser()
    if not path.is_absolute() or raw == ":memory:":
        raise RunnerConfigError("SANDRA_REPAIR_DB_PATH must be an absolute durable file path")
    if path.name in {"", ".", ".."} or path.exists() and path.is_dir():
        raise RunnerConfigError("SANDRA_REPAIR_DB_PATH must name a file")
    if not path.parent.is_dir():
        raise RunnerConfigError("SANDRA_REPAIR_DB_PATH parent directory must already exist")
    resolved = path.resolve()
    if volume_path is not None and volume_path not in resolved.parents:
        raise RunnerConfigError("SANDRA_REPAIR_DB_PATH must reside under SANDRA_REPAIR_VOLUME_PATH")
    if path.exists() and not os.access(path, os.R_OK | os.W_OK):
        raise RunnerConfigError("SANDRA_REPAIR_DB_PATH is not readable and writable")
    if not os.access(path.parent, os.W_OK):
        raise RunnerConfigError("SANDRA_REPAIR_DB_PATH parent is not writable")
    return resolved


def _is_effective_mount(path: Path) -> bool:
    """Return whether the path is a real mounted volume, not image storage."""

    return path.is_mount()


def _volume_path(env: Mapping[str, str]) -> Path:
    raw = _required_text(env, "SANDRA_REPAIR_VOLUME_PATH")
    path = Path(raw).expanduser()
    if not path.is_absolute() or path.resolve() == Path("/"):
        raise RunnerConfigError("SANDRA_REPAIR_VOLUME_PATH must be a non-root absolute path")
    if not path.is_dir() or not _is_effective_mount(path):
        raise RunnerConfigError("SANDRA_REPAIR_VOLUME_PATH must be an effective mounted directory")
    resolved = path.resolve()
    if not os.access(resolved, os.W_OK):
        raise RunnerConfigError("SANDRA_REPAIR_VOLUME_PATH is not writable")
    return resolved


def _private_key(env: Mapping[str, str], name: str) -> str:
    value = _required_text(env, name)
    if len(value) > 32_000 or "BEGIN ENCRYPTED PRIVATE KEY" in value:
        raise RunnerConfigError(f"{name} must be an unencrypted RSA PEM")
    if not (
        ("BEGIN RSA PRIVATE KEY" in value and "END RSA PRIVATE KEY" in value)
        or ("BEGIN PRIVATE KEY" in value and "END PRIVATE KEY" in value)
    ):
        raise RunnerConfigError(f"{name} must be an RSA private-key PEM")
    return value


@dataclass(frozen=True)
class RunnerConfig:
    """Validated process configuration.

    Credential fields are excluded from the repr so accidental diagnostic
    rendering cannot disclose them.
    """

    db_path: Path
    sentry_token: str = field(repr=False)
    volume_path: Path = EXPECTED_VOLUME_PATH
    github_publish_enabled: bool = False
    github_app_id: int | None = None
    github_installation_id: int | None = None
    github_app_private_key: str | None = field(default=None, repr=False)
    github_api_base_url: str = "https://api.github.com"
    repository: str = DEFAULT_REPOSITORY
    publisher_owner: str = "sandra-controller"
    poll_seconds: int = DEFAULT_POLL_SECONDS
    max_publishes_per_cycle: int = DEFAULT_MAX_PUBLISHES
    publisher_lease_seconds: int = DEFAULT_PUBLISHER_LEASE_SECONDS
    max_cycle_retries: int = DEFAULT_MAX_CYCLE_RETRIES
    backoff_base_seconds: int = DEFAULT_BACKOFF_BASE_SECONDS
    backoff_max_seconds: int = DEFAULT_BACKOFF_MAX_SECONDS
    health_host: str = DEFAULT_HEALTH_HOST
    health_port: int = DEFAULT_HEALTH_PORT
    repair_dispatch_enabled: bool = False
    repair_dispatch_gate: str | None = None
    organization: str = DEFAULT_ORGANIZATION
    project: str = DEFAULT_PROJECT
    environment: str = DEFAULT_ENVIRONMENT

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "RunnerConfig":
        values = os.environ if env is None else env
        volume_path = _volume_path(values)
        db_path = _db_path(values, volume_path=volume_path)
        sentry_token = _secret(values, "SENTRY_AUTH_TOKEN")
        github_enabled = _strict_bool(values, "SANDRA_GITHUB_PUBLISH_ENABLED")
        github_app_id: int | None = None
        github_installation_id: int | None = None
        github_app_private_key: str | None = None
        api_base_url = str(values.get("SANDRA_GITHUB_API_BASE_URL", "https://api.github.com")).strip()
        if not api_base_url.startswith("https://"):
            raise RunnerConfigError("SANDRA_GITHUB_API_BASE_URL must use HTTPS")
        if github_enabled:
            if str(values.get("GITHUB_TOKEN", "")).strip():
                raise RunnerConfigError(
                    "static GITHUB_TOKEN is unsupported; configure renewable GitHub App credentials"
                )
            try:
                github_app_id = _bounded_int(
                    values,
                    "SANDRA_GITHUB_APP_ID",
                    default=0,
                    minimum=1,
                    maximum=9_223_372_036_854_775_807,
                )
                github_installation_id = _bounded_int(
                    values,
                    "SANDRA_GITHUB_INSTALLATION_ID",
                    default=0,
                    minimum=1,
                    maximum=9_223_372_036_854_775_807,
                )
            except RunnerConfigError:
                raise
            github_app_private_key = _private_key(values, "SANDRA_GITHUB_APP_PRIVATE_KEY")
        try:
            repository = validate_repository(
                str(values.get("SANDRA_GITHUB_REPOSITORY", DEFAULT_REPOSITORY)).strip()
            )
        except ValueError as exc:
            raise RunnerConfigError("SANDRA_GITHUB_REPOSITORY is invalid") from exc
        owner = str(values.get("SANDRA_GITHUB_PUBLISHER_OWNER", "sandra-controller")).strip()
        if not owner or len(owner) > 100 or any(character in owner for character in ("\x00", "\r", "\n")):
            raise RunnerConfigError("SANDRA_GITHUB_PUBLISHER_OWNER is invalid")

        dispatch_enabled = _strict_bool(values, "SANDRA_REPAIR_DISPATCH_ENABLED")
        gate = str(values.get("SANDRA_REPAIR_DISPATCH_GATE", "")).strip() or None
        if dispatch_enabled and gate != REPAIR_GATE:
            raise RunnerConfigError(
                "SANDRA_REPAIR_DISPATCH_GATE must be staged-v1 when repair dispatch is enabled"
            )
        # This runner intentionally stops before worker dispatch even when a
        # caller supplies the future gate. That gate is a configuration
        # contract for a separately reviewed staged dispatcher, not an
        # accidental switch on a long-lived service.
        if dispatch_enabled:
            raise RunnerConfigError(
                "repair dispatch gate staged-v1 is reserved for a separately reviewed rollout"
            )

        port = _bounded_int(values, "PORT", default=DEFAULT_HEALTH_PORT, minimum=1, maximum=65535)
        host = str(values.get("SANDRA_REPAIR_HEALTH_HOST", DEFAULT_HEALTH_HOST)).strip()
        if not host or len(host) > 255 or any(character.isspace() for character in host):
            raise RunnerConfigError("SANDRA_REPAIR_HEALTH_HOST is invalid")
        return cls(
            db_path=db_path,
            volume_path=volume_path,
            sentry_token=sentry_token,
            github_publish_enabled=github_enabled,
            github_app_id=github_app_id,
            github_installation_id=github_installation_id,
            github_app_private_key=github_app_private_key,
            github_api_base_url=api_base_url,
            repository=repository,
            publisher_owner=owner,
            poll_seconds=_bounded_int(values, "SANDRA_REPAIR_POLL_SECONDS", default=DEFAULT_POLL_SECONDS, minimum=1, maximum=3600),
            max_publishes_per_cycle=_bounded_int(values, "SANDRA_REPAIR_MAX_PUBLISHES_PER_CYCLE", default=DEFAULT_MAX_PUBLISHES, minimum=1, maximum=100),
            publisher_lease_seconds=_bounded_int(values, "SANDRA_REPAIR_PUBLISHER_LEASE_SECONDS", default=DEFAULT_PUBLISHER_LEASE_SECONDS, minimum=15, maximum=3600),
            max_cycle_retries=_bounded_int(values, "SANDRA_REPAIR_MAX_CYCLE_RETRIES", default=DEFAULT_MAX_CYCLE_RETRIES, minimum=0, maximum=10),
            backoff_base_seconds=_bounded_int(values, "SANDRA_REPAIR_BACKOFF_BASE_SECONDS", default=DEFAULT_BACKOFF_BASE_SECONDS, minimum=1, maximum=300),
            backoff_max_seconds=_bounded_int(values, "SANDRA_REPAIR_BACKOFF_MAX_SECONDS", default=DEFAULT_BACKOFF_MAX_SECONDS, minimum=1, maximum=3600),
            health_host=host,
            health_port=port,
        )


class Backoff:
    """Bounded exponential retry delay without unbounded sleeping."""

    def __init__(self, base_seconds: int, max_seconds: int) -> None:
        self.base_seconds = base_seconds
        self.max_seconds = max_seconds
        self.failures = 0

    def failure_delay(self) -> float:
        delay = min(self.max_seconds, self.base_seconds * (2 ** self.failures))
        self.failures += 1
        return float(delay)

    def reset(self) -> None:
        self.failures = 0


@dataclass
class HealthState:
    """Thread-safe, sanitized operational state exposed by /healthz."""

    started_at: float = field(default_factory=time.time)
    cycles_total: int = 0
    cycles_failed: int = 0
    last_success_at: float | None = None
    last_slot_id: str | None = None
    last_error_type: str | None = None
    last_publisher_error_type: str | None = None
    last_publisher_failure_at: float | None = None
    last_publisher_success_at: float | None = None
    publisher_outstanding_count: int = 0
    intake_succeeded: bool = False
    publisher_degraded: bool = False
    stopping: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def record_cycle(self) -> None:
        with self._lock:
            self.cycles_total += 1

    def record_success(self, slot_id: str | None, observed_at: float) -> None:
        with self._lock:
            self.intake_succeeded = True
            self.last_success_at = float(observed_at)
            self.last_slot_id = slot_id
            self.last_error_type = None

    def record_publisher_failure(self, error_type: str, observed_at: float | None = None) -> None:
        with self._lock:
            self.publisher_degraded = True
            self.last_publisher_error_type = error_type[:120]
            self.last_publisher_failure_at = time.time() if observed_at is None else float(observed_at)

    def record_publisher_success(self, observed_at: float | None = None) -> None:
        with self._lock:
            self.publisher_degraded = False
            self.publisher_outstanding_count = 0
            self.last_publisher_error_type = None
            self.last_publisher_success_at = time.time() if observed_at is None else float(observed_at)

    def record_publisher_backlog(
        self,
        *,
        failed_count: int,
        create_unknown_count: int,
        observed_at: float | None = None,
    ) -> None:
        """Apply the persisted publisher state without clearing other jobs.

        The counts come from SQLite, rather than from the last item handled
        during this process cycle.  This keeps readiness truthful when one
        item succeeds while another item's failure or create ambiguity is
        still outstanding.
        """

        failed = max(0, int(failed_count))
        create_unknown = max(0, int(create_unknown_count))
        outstanding = failed + create_unknown
        observed = time.time() if observed_at is None else float(observed_at)
        with self._lock:
            was_degraded = self.publisher_degraded
            self.publisher_outstanding_count = outstanding
            if outstanding:
                self.publisher_degraded = True
                state = "create_unknown" if create_unknown else "failed"
                self.last_publisher_error_type = f"publisher_{state}_backlog"
                if not was_degraded or self.last_publisher_failure_at is None:
                    self.last_publisher_failure_at = observed
            else:
                self.publisher_degraded = False
                self.last_publisher_error_type = None
                self.last_publisher_success_at = observed

    def record_failure(self, error_type: str) -> None:
        with self._lock:
            self.cycles_failed += 1
            self.last_error_type = error_type[:120]

    def request_stop(self) -> None:
        with self._lock:
            self.stopping = True

    def payload(self, now: float | None = None) -> dict[str, Any]:
        current = time.time() if now is None else float(now)
        with self._lock:
            ready = self.intake_succeeded and not self.publisher_degraded and not self.last_error_type and not self.stopping
            if self.stopping:
                status = "stopping"
            elif ready:
                status = "ok"
            elif self.last_error_type or self.publisher_degraded:
                status = "degraded"
            else:
                status = "starting"
            return {
                "service": "sandra-sentry-repair",
                "status": status,
                "started_at": self.started_at,
                "uptime_seconds": max(0.0, current - self.started_at),
                "cycles_total": self.cycles_total,
                "cycles_failed": self.cycles_failed,
                "last_success_at": self.last_success_at,
                "last_slot_id": self.last_slot_id,
                "last_error_type": self.last_error_type,
                "last_publisher_error_type": self.last_publisher_error_type,
                "last_publisher_failure_at": self.last_publisher_failure_at,
                "last_publisher_success_at": self.last_publisher_success_at,
                "publisher_outstanding_count": self.publisher_outstanding_count,
                "intake_succeeded": self.intake_succeeded,
                "publisher_degraded": self.publisher_degraded,
                "ready": ready,
            }


def _log(event: str, **fields: Any) -> None:
    """Emit fixed-shape JSON with no exception or credential contents."""

    record: dict[str, Any] = {"event": event, "ts": datetime.now(timezone.utc).isoformat()}
    for key, value in fields.items():
        if (
            key.endswith("_token")
            or key in {"token", "secret", "password", "authorization"}
            or "secret" in key.lower()
        ):
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            record[key] = value
    LOGGER.info(json.dumps(record, sort_keys=True, separators=(",", ":")))


@dataclass(frozen=True)
class CycleResult:
    status: str
    slot_id: str | None = None
    intake_changed: int = 0
    queued: int = 0
    published: int = 0
    publisher_failures: int = 0
    error_type: str | None = None
    retry_delay_seconds: float | None = None


class _HealthHandler(BaseHTTPRequestHandler):
    """Small HTTP handler with no request-body or header logging."""

    state: HealthState

    def do_GET(self) -> None:  # noqa: N802
        if self.path not in {"/healthz", "/readyz"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        payload = self.state.payload()
        is_ready = bool(payload["ready"])
        body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.send_response(HTTPStatus.OK if self.path == "/healthz" or is_ready else HTTPStatus.SERVICE_UNAVAILABLE)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class ControllerRunner:
    """Run one current Chicago slot at a time with restart-safe claims."""

    def __init__(
        self,
        config: RunnerConfig,
        *,
        store: RepairStore | Any | None = None,
        sentry_client: SentryClient | Any | None = None,
        github_client: GitHubClient | Any | None = None,
        github_token_provider: Any | None = None,
        clock: Callable[[], float] | None = None,
        wait: Callable[[float], None] | None = None,
        health: HealthState | None = None,
    ) -> None:
        self.config = config
        self.clock = clock or time.time
        self._wait = wait or time.sleep
        self.store = store or RepairStore(config.db_path)
        self.sentry = sentry_client or SentryClient(
            SentryConfig(
                organization=config.organization,
                project=config.project,
                environment=config.environment,
            ),
            token=config.sentry_token,
        )
        if config.github_publish_enabled:
            if github_token_provider is None:
                if (
                    config.github_app_id is None
                    or config.github_installation_id is None
                    or not config.github_app_private_key
                ):
                    raise RunnerConfigError(
                        "GitHub publishing requires renewable GitHub App credentials"
                    )
                github_token_provider = GitHubAppTokenProvider(
                    app_id=config.github_app_id,
                    installation_id=config.github_installation_id,
                    private_key=config.github_app_private_key,
                    base_url=config.github_api_base_url,
                )
            self.github_token_provider = github_token_provider
            self.github = github_client or GitHubClient(
                repository=config.repository,
                token_provider=github_token_provider,
                base_url=config.github_api_base_url,
            )
        else:
            self.github_token_provider = None
            self.github = None
        self.publisher = (
            GitHubPublisher(
                self.store,
                self.github,
                owner=config.publisher_owner,
                lease_seconds=config.publisher_lease_seconds,
            )
            if self.github is not None
            else None
        )
        self.health = health or HealthState(started_at=self.clock())
        self.stop_event = threading.Event()
        self.backoff = Backoff(config.backoff_base_seconds, config.backoff_max_seconds)
        self._retry_slot: tuple[str, datetime, int] | None = None
        self._server: ThreadingHTTPServer | None = None
        self._server_thread: threading.Thread | None = None
        self._closed = False
        if self.publisher is not None:
            self._refresh_publisher_health(self.clock())

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.stop_health_server()
        close = getattr(self.store, "close", None)
        if callable(close):
            close()

    def request_stop(self, *_args: Any) -> None:
        self.health.request_stop()
        self.stop_event.set()
        _log("runner_stop_requested")

    def install_signal_handlers(self) -> None:
        signal.signal(signal.SIGTERM, self.request_stop)
        signal.signal(signal.SIGINT, self.request_stop)

    def start_health_server(self) -> tuple[str, int]:
        if self._server is not None:
            return self._server.server_address
        handler = type("SandraHealthHandler", (_HealthHandler,), {"state": self.health})
        server = ThreadingHTTPServer((self.config.health_host, self.config.health_port), handler)
        server.daemon_threads = True
        self._server = server
        self._server_thread = threading.Thread(
            target=server.serve_forever,
            kwargs={"poll_interval": 0.25},
            name="sandra-health",
            daemon=True,
        )
        self._server_thread.start()
        _log("health_server_started", host=self.config.health_host, port=server.server_address[1])
        return server.server_address

    def stop_health_server(self) -> None:
        server, thread = self._server, self._server_thread
        self._server = self._server_thread = None
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2)

    def _refresh_publisher_health(self, observed_at: float) -> None:
        """Reconcile readiness with the durable GitHub publication backlog."""

        if self.publisher is None:
            return
        health = getattr(self.store, "github_publisher_health", None)
        if callable(health):
            counts = health()
        else:
            # Keep test doubles and older local stores safe while the durable
            # method is rolled out: only these terminally unsafe states count.
            rows = getattr(self.store, "list_github_outbox", lambda: [])()
            counts = {
                "failed": sum(1 for row in rows if row.get("status") == "failed"),
                "create_unknown": sum(
                    1 for row in rows if row.get("status") == "create_unknown"
                ),
            }
        self.health.record_publisher_backlog(
            failed_count=int(counts.get("failed", 0)),
            create_unknown_count=int(counts.get("create_unknown", 0)),
            observed_at=observed_at,
        )

    def _claim_slot(self, now: float) -> tuple[str, datetime] | None:
        current = datetime.fromtimestamp(now, tz=timezone.utc)
        if self._retry_slot is not None:
            retry_id, retry_slot, retry_count = self._retry_slot
            if retry_id == slot_identity(current_slot(current)) and retry_count <= self.config.max_cycle_retries:
                return retry_id, retry_slot
            self._retry_slot = None
        slot = current_slot(current)
        slot_id = slot_identity(slot)
        get_slot = getattr(self.store, "get_scheduler_slot", None)
        if callable(get_slot):
            persisted = get_slot(slot_id)
            # A process can die after SQLite claims a slot but before its
            # Sentry transaction completes. Resume that exact current slot;
            # ingestion and the marker-based publisher are idempotent. A
            # completed or terminally failed slot is never replayed.
            if persisted is not None:
                state = str(persisted.get("status", ""))
                if state == "claimed":
                    return slot_id, slot
                if state in {"completed", "failed"}:
                    return None
        return due_slot(current, self.store)

    def _run_claimed_slot(self, slot_id: str, slot: datetime, now: float) -> CycleResult:
        changed = intake_from_sentry(self.store, self.sentry, retrieved_at=now)
        self.health.record_success(slot_id, now)
        queued = 0
        published = 0
        publisher_failures = 0
        if self.publisher is not None:
            for row in self.store.list_issues(
                self.config.organization,
                self.config.project,
                self.config.environment,
                statuses=("new", "unresolved"),
            ):
                result = enqueue_candidate(
                    self.store,
                    organization=self.config.organization,
                    project=self.config.project,
                    environment=self.config.environment,
                    issue_number=int(row["issue_number"]),
                    repository=self.config.repository,
                    now=now,
                )
                if result.action in {"queued", "already_queued"}:
                    queued += 1
            for _ in range(self.config.max_publishes_per_cycle):
                result = self.publisher.publish_one(now=now)
                if result is None:
                    break
                if result.action in {"created", "reconciled"}:
                    published += 1
                elif result.action in {"failed", "create_unknown", "awaiting_marker", "reconcile_required"}:
                    publisher_failures += 1
            self._refresh_publisher_health(now)
        _log(
            "slot_completed",
            slot_id=slot_id,
            intake_changed=len(changed),
            queued=queued,
            published=published,
            publisher_failures=publisher_failures,
            github_publishing=self.publisher is not None,
            repair_dispatch=False,
        )
        return CycleResult(
            "completed",
            slot_id=slot_id,
            intake_changed=len(changed),
            queued=queued,
            published=published,
            publisher_failures=publisher_failures,
        )

    def run_once(self, now: float | None = None) -> CycleResult:
        """Run the current slot once; persisted claims prevent restart replay."""

        observed_at = self.clock() if now is None else float(now)
        self.health.record_cycle()
        try:
            claimed = self._claim_slot(observed_at)
        except Exception as exc:  # noqa: BLE001 - state outages must be retried
            error_type = type(exc).__name__
            self.health.record_failure(error_type)
            _log("slot_claim_failed", error_type=error_type)
            return CycleResult(
                "failed",
                error_type=error_type,
                retry_delay_seconds=self.backoff.failure_delay(),
            )
        if claimed is None:
            return CycleResult("not_due")
        slot_id, slot = claimed
        try:
            result = self._run_claimed_slot(slot_id, slot, observed_at)
            complete_slot = getattr(self.store, "complete_scheduler_slot", None)
            if callable(complete_slot):
                complete_slot(slot_id, now=observed_at)
        except Exception as exc:  # noqa: BLE001 - process must retry safely
            error_type = type(exc).__name__
            self.health.record_failure(error_type)
            retry_count = 1 if self._retry_slot is None else self._retry_slot[2] + 1
            if retry_count <= self.config.max_cycle_retries:
                self._retry_slot = (slot_id, slot, retry_count)
            else:
                self._retry_slot = None
                fail_slot = getattr(self.store, "fail_scheduler_slot", None)
                if callable(fail_slot):
                    fail_slot(slot_id, error=error_type, now=observed_at)
            _log("slot_failed", slot_id=slot_id, error_type=error_type, retry_count=retry_count)
            return CycleResult(
                "failed",
                slot_id=slot_id,
                error_type=error_type,
                retry_delay_seconds=self.backoff.failure_delay(),
            )
        self._retry_slot = None
        self.backoff.reset()
        return result

    def run_forever(self) -> None:
        """Serve health checks and poll without busy looping."""

        self.install_signal_handlers()
        self.start_health_server()
        _log(
            "runner_started",
            poll_seconds=self.config.poll_seconds,
            github_publishing=self.publisher is not None,
            repair_dispatch=False,
        )
        try:
            while not self.stop_event.is_set():
                result = self.run_once()
                delay = result.retry_delay_seconds if result.status == "failed" else self.config.poll_seconds
                self.stop_event.wait(delay)
        finally:
            self.request_stop()
            self.close()
            _log("runner_stopped")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Sandra durable Sentry repair intake runner")
    root.add_argument("--once", action="store_true", help="run one current schedule slot and exit")
    return root


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = parser().parse_args(argv)
    config = RunnerConfig.from_env()
    runner = ControllerRunner(config)
    try:
        if args.once:
            result = runner.run_once()
            print(json.dumps(result.__dict__, sort_keys=True))
            return 0 if result.status in {"completed", "not_due"} else 1
        runner.run_forever()
        return 0
    finally:
        runner.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RunnerConfigError as exc:
        # Configuration errors are operator-actionable but must not emit a
        # traceback that might include an environment-derived value.
        print(f"configuration error: {exc}", file=sys.stderr)
        raise SystemExit(2)
    except Exception as exc:  # noqa: BLE001 - keep process diagnostics secret-free
        print(f"runner error: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1)
