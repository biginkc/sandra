"""Bounded codex exec dispatch with preflight selection and model no-retry policy."""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol

from prompts import build_investigation_prompt, build_review_prompt
from store import FencingError, StateError
from validation import validate_model_outcome


SPARK_MODEL = "gpt-5.3-codex-spark"
LUNA_MODEL = "gpt-5.6-luna"
ASTRA_REVIEW_MODEL = "gpt-6-astra"
FABLE_REVIEW_MODEL = "claude-fable-5-1"
_PRODUCTION_SECRET_ENV = frozenset(
    {
        "SENTRY_AUTH_TOKEN",
        "SENTRY_DSN",
        "VERCEL_TOKEN",
        "VERCEL_ORG_ID",
        "VERCEL_PROJECT_ID",
        "DATABASE_URL",
        "DIRECT_URL",
        "POSTGRES_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SERVICE_ROLE",
        "SUPABASE_DB_PASSWORD",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "NPM_TOKEN",
        "GITLAB_TOKEN",
        "BITBUCKET_TOKEN",
        "AZURE_DEVOPS_EXT_PAT",
        "RAILWAY_TOKEN",
        "FLY_API_TOKEN",
        "HEROKU_API_KEY",
        "CLOUDFLARE_API_TOKEN",
        "STRIPE_SECRET_KEY",
        "STRIPE_API_KEY",
        "RESEND_API_KEY",
        "SLACK_BOT_TOKEN",
        "SLACK_TOKEN",
        "DISCORD_TOKEN",
        "TELEGRAM_BOT_TOKEN",
        "TWILIO_AUTH_TOKEN",
        "FIREBASE_TOKEN",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "DOCKER_PASSWORD",
        "SANDRA_FENCING_TOKEN",
    }
)
_WORKER_ENV_ALLOWLIST = frozenset(
    {
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "TERM",
        "COLORTERM",
        "NO_COLOR",
        "TMPDIR",
        "TMP",
        "TEMP",
        "TZ",
        "CODEX_HOME",
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
    }
)
MAX_HEARTBEAT_RETRIES = 2


def kill_process_group(process) -> None:
    """Kill a Codex process and descendants without shell invocation."""

    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (AttributeError, OSError, ProcessLookupError):
        try:
            process.kill()
        except ProcessLookupError:
            pass


@dataclass(frozen=True)
class ProcessResult:
    status: str
    stdout: str = ""
    stderr: str = ""
    returncode: int = 0
    session_id: str | None = None


class Executor(Protocol):
    def probe(self, model: str, effort: str) -> ProcessResult: ...

    def run(self, argv: list[str], *, timeout_seconds: int) -> ProcessResult: ...


def codex_argv(
    model: str, effort: str, prompt: str, *, sandbox: str = "workspace-write"
) -> list[str]:
    if model not in {SPARK_MODEL, LUNA_MODEL, ASTRA_REVIEW_MODEL}:
        raise ValueError(f"unsupported model {model}")
    if effort not in {"low", "medium", "xhigh"}:
        raise ValueError(f"unsupported reasoning effort {effort}")
    if model == LUNA_MODEL and effort != "xhigh":
        raise ValueError("Luna fallback is restricted to xhigh")
    if model == ASTRA_REVIEW_MODEL and effort != "medium":
        raise ValueError("Astra review is restricted to medium")
    if sandbox not in {"read-only", "workspace-write"}:
        raise ValueError("sandbox must be read-only or workspace-write")
    # Passing argv directly to subprocess prevents issue text from becoming
    # shell syntax. The prompt remains a single final argument.
    return [
        "codex",
        "exec",
        "--model",
        model,
        "-c",
        f"model_reasoning_effort={json.dumps(effort)}",
        "--sandbox",
        sandbox,
        "--json",
        prompt,
    ]


class SubprocessExecutor:
    """Real CLI adapter; callers must opt into execute mode explicitly."""

    def __init__(
        self,
        executable: str = "codex",
        worktree: str | None = None,
        fencing_env_name: str | None = None,
    ) -> None:
        self.executable = executable
        self.worktree = worktree
        self.fencing_env_name = fencing_env_name

    @staticmethod
    def _worker_environment(
        *, scrub_names: set[str] | frozenset[str] | None = None
    ) -> dict[str, str]:
        """Build a small environment with model auth and no repo secrets."""

        scrub = set(_PRODUCTION_SECRET_ENV)
        scrub.update(scrub_names or ())
        return {
            key: value
            for key, value in os.environ.items()
            if key in _WORKER_ENV_ALLOWLIST and key not in scrub
        }

    def _subprocess_environment(self) -> dict[str, str]:
        scrub_names = set()
        if self.fencing_env_name:
            scrub_names.add(self.fencing_env_name)
        return self._worker_environment(scrub_names=scrub_names)

    def probe(self, model: str, effort: str) -> ProcessResult:
        probe_prompt = (
            "This is a model availability probe. Return exactly MODEL_PROBE_OK. "
            "Do not inspect files, edit files, or take any external action."
        )
        argv = codex_argv(model, effort, probe_prompt)
        # A probe is read-only by instruction and by the CLI sandbox flag.
        argv[argv.index("--sandbox") + 1] = "read-only"
        result = self._run(argv, timeout_seconds=60)
        if result.status == "success":
            return ProcessResult(
                "available",
                result.stdout,
                result.stderr,
                result.returncode,
                result.session_id,
            )
        return result

    def run(self, argv: list[str], *, timeout_seconds: int) -> ProcessResult:
        return self._run(argv, timeout_seconds=timeout_seconds)

    def run_with_heartbeat(
        self,
        argv: list[str],
        *,
        timeout_seconds: int,
        heartbeat,
        heartbeat_interval_seconds: int = 30,
    ) -> ProcessResult:
        return self._run(
            argv,
            timeout_seconds=timeout_seconds,
            heartbeat=heartbeat,
            heartbeat_interval_seconds=heartbeat_interval_seconds,
        )

    @staticmethod
    def _session_id(stdout: str) -> str | None:
        for line in reversed(stdout.splitlines()):
            try:
                event = json.loads(line)
            except (TypeError, ValueError):
                continue
            if isinstance(event, dict) and event.get("type") in {"thread.started", "thread.created"}:
                for key in ("session_id", "thread_id"):
                    value = event.get(key)
                    if isinstance(value, str) and value.strip():
                        return value.strip()
                item = event.get("item")
                if isinstance(item, dict):
                    value = item.get("thread_id") or item.get("session_id")
                    if isinstance(value, str) and value.strip():
                        return value.strip()
        return None

    def _run(
        self,
        argv: list[str],
        *,
        timeout_seconds: int,
        heartbeat=None,
        heartbeat_interval_seconds: int = 30,
    ) -> ProcessResult:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if heartbeat_interval_seconds <= 0:
            raise ValueError("heartbeat_interval_seconds must be positive")
        started = time.monotonic()
        next_heartbeat = started + heartbeat_interval_seconds
        heartbeat_failures = 0
        # Files avoid a pipe-buffer deadlock if a worker emits a large JSONL
        # trace while the controller is polling for heartbeats.
        with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as stdout_file, tempfile.TemporaryFile(
            mode="w+", encoding="utf-8"
        ) as stderr_file:
            command = (
                [self.executable, *argv[1:]]
                if argv and argv[0] == "codex"
                else list(argv)
            )
            try:
                process = subprocess.Popen(
                    command,
                    stdin=subprocess.DEVNULL,
                    stdout=stdout_file,
                    stderr=stderr_file,
                    cwd=self.worktree,
                    start_new_session=True,
                    env=self._subprocess_environment(),
                )
            except OSError as exc:
                return ProcessResult("error", "", str(exc), -1)

            def collect() -> tuple[str, str]:
                stdout_file.flush()
                stderr_file.flush()
                stdout_file.seek(0)
                stderr_file.seek(0)
                return stdout_file.read(), stderr_file.read()

            previous_handlers: dict[int, Any] = {}

            def stop_child_on_signal(signum, _frame):
                kill_process_group(process)
                raise SystemExit(128 + signum)

            # A normal Python exception is handled by the finally block below.
            # For CLI termination signals, install a short-lived handler so
            # the child group is also fenced before the controller exits.
            try:
                if threading.current_thread() is threading.main_thread():
                    termination_signals = [signal.SIGINT, signal.SIGTERM]
                    # SIGHUP is the normal terminal/session hangup signal on
                    # Unix.  It must fence the child process group as well;
                    # otherwise closing a controller terminal can leave a
                    # detached worker running after the lease owner died.
                    if hasattr(signal, "SIGHUP"):
                        termination_signals.append(signal.SIGHUP)
                    for signum in termination_signals:
                        try:
                            # Preserve nohup/launchd's inherited ignore
                            # disposition. Overriding SIG_IGN would turn an
                            # intentionally detached controller into one that
                            # unexpectedly exits on terminal hangup.
                            if signal.getsignal(signum) == signal.SIG_IGN:
                                continue
                            previous_handlers[signum] = signal.signal(signum, stop_child_on_signal)
                        except (OSError, ValueError):
                            continue
                while process.poll() is None:
                    now = time.monotonic()
                    if now - started >= timeout_seconds:
                        kill_process_group(process)
                        process.wait()
                        stdout, stderr = collect()
                        return ProcessResult(
                            "timeout",
                            stdout,
                            stderr,
                            process.returncode if process.returncode is not None else -1,
                            self._session_id(stdout),
                        )
                    if heartbeat is not None and now >= next_heartbeat:
                        try:
                            heartbeat()
                            heartbeat_failures = 0
                            next_heartbeat = now + heartbeat_interval_seconds
                        except FencingError as exc:
                            # Reconciliation can fence a worker while its
                            # child is still running. Fencing is immediate.
                            kill_process_group(process)
                            process.wait()
                            stdout, stderr = collect()
                            return ProcessResult(
                                "stale",
                                stdout,
                                f"{stderr}\nheartbeat fenced: {exc}",
                                process.returncode if process.returncode is not None else -1,
                                self._session_id(stdout),
                            )
                        except Exception as exc:
                            heartbeat_failures += 1
                            if heartbeat_failures <= MAX_HEARTBEAT_RETRIES:
                                # Retry transient state-store failures quickly
                                # but with a hard bound before killing the
                                # worker and terminalizing its attempt.
                                next_heartbeat = now + min(1.0, heartbeat_interval_seconds)
                            else:
                                kill_process_group(process)
                                process.wait()
                                stdout, stderr = collect()
                                return ProcessResult(
                                    "error",
                                    stdout,
                                    f"{stderr}\nheartbeat failed after {heartbeat_failures} attempts: {exc}",
                                    process.returncode if process.returncode is not None else -1,
                                    self._session_id(stdout),
                                )
                    time.sleep(min(0.25, max(0.01, timeout_seconds - (now - started))))
                process.wait()
                stdout, stderr = collect()
                status = "success" if process.returncode == 0 else "error"
                return ProcessResult(
                    status,
                    stdout,
                    stderr,
                    process.returncode or 0,
                    self._session_id(stdout),
                )
            finally:
                for signum, handler in previous_handlers.items():
                    try:
                        signal.signal(signum, handler)
                    except (OSError, ValueError):
                        pass
                # Covers KeyboardInterrupt, SystemExit, unexpected adapter
                # errors, and exceptions from output collection. The child
                # group must never outlive the controller invocation.
                if process.poll() is None:
                    kill_process_group(process)
                    try:
                        process.wait(timeout=5)
                    except (OSError, subprocess.TimeoutExpired):
                        process.kill()
                        process.wait()


def choose_execution_model(
    executor: Executor, *, spark_effort: str = "low"
) -> tuple[str, str, ProcessResult]:
    if spark_effort not in {"low", "medium"}:
        raise ValueError("Spark effort must be low or medium")
    probe = executor.probe(SPARK_MODEL, spark_effort)
    selection = validate_model_outcome(SPARK_MODEL, {
        "status": probe.status,
        "stdout": probe.stdout,
        "stderr": probe.stderr,
    })
    if selection == "available":
        return SPARK_MODEL, spark_effort, probe
    # Luna is selected only after a verified pre-work Spark unavailability.
    return LUNA_MODEL, "xhigh", probe


def _terminalize_failure(store, attempt_id: str, fencing_token: str, reason: str) -> str | None:
    """Best-effort terminalization; return fencing marker for stale workers."""

    try:
        store.fail_attempt(attempt_id, fencing_token, reason=reason)
    except FencingError:
        return "FencingError"
    except Exception as exc:
        return type(exc).__name__
    return None


def _heartbeat_with_retries(store, attempt_id: str, fencing_token: str, *, lease_seconds: int) -> float:
    """Retry transient state-store errors without ever retrying a fence."""

    for retry in range(MAX_HEARTBEAT_RETRIES + 1):
        try:
            return store.heartbeat(
                attempt_id, fencing_token, lease_seconds=lease_seconds
            )
        except FencingError:
            raise
        except Exception:
            if retry >= MAX_HEARTBEAT_RETRIES:
                raise
    raise AssertionError("unreachable heartbeat retry state")


def _git_capture(worktree: str, *arguments: str) -> subprocess.CompletedProcess[str]:
    """Run a fixed-argument Git inspection without invoking a shell."""

    return subprocess.run(
        ["git", "-C", worktree, *arguments],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )


@contextmanager
def _fresh_review_checkout(worktree: str, expected_sha: str):
    """Yield a clean detached checkout of the exact reviewed commit.

    The worker checkout is checked before cloning, so a patch or instruction
    file left behind by the repair worker cannot become review input. The
    temporary clone is a sibling of that checkout and is removed before the
    review dispatch returns.
    """

    if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", str(expected_sha or "")):
        raise StateError("review requires a full immutable commit SHA")
    source = str(Path(worktree).expanduser().resolve())
    if not (Path(source) / ".git").is_file():
        raise StateError("review source must be an isolated linked Git worktree")
    try:
        head = _git_capture(source, "rev-parse", "HEAD")
        clean = _git_capture(source, "status", "--porcelain=v1", "--untracked-files=all")
        exists = _git_capture(source, "cat-file", "-e", f"{expected_sha}^{{commit}}")
    except (OSError, subprocess.SubprocessError) as exc:
        raise StateError("unable to inspect review worktree") from exc
    if head.returncode != 0 or head.stdout.strip().lower() != str(expected_sha).lower():
        raise StateError("review worktree HEAD does not match immutable reviewed SHA")
    if clean.returncode != 0 or clean.stdout:
        raise StateError("review worktree must be clean before independent review")
    if exists.returncode != 0:
        raise StateError("reviewed commit is not present in the worker repository")

    parent = str(Path(source).parent)
    try:
        with tempfile.TemporaryDirectory(prefix=".sandra-review-", dir=parent) as temporary:
            checkout = str(Path(temporary) / "checkout")
            cloned = subprocess.run(
                ["git", "clone", "--no-local", "--quiet", source, checkout],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            if cloned.returncode != 0:
                raise StateError(f"unable to create independent review checkout: {cloned.stderr.strip()}")
            detached = _git_capture(checkout, "checkout", "--quiet", "--detach", str(expected_sha))
            cloned_head = _git_capture(checkout, "rev-parse", "HEAD")
            if detached.returncode != 0 or cloned_head.stdout.strip().lower() != str(expected_sha).lower():
                raise StateError("independent review checkout is not at immutable reviewed SHA")
            project_config = Path(checkout) / ".codex" / "config.toml"
            if project_config.exists() or project_config.is_symlink():
                if not project_config.is_file() and not project_config.is_symlink():
                    raise StateError("project Codex config must not enter independent review")
                # A committed project config can change model policy, tools,
                # or approvals. Remove it from the ephemeral review checkout
                # before launching the reviewer.
                project_config.unlink()
                masked = _git_capture(
                    checkout, "update-index", "--skip-worktree", ".codex/config.toml"
                )
                if masked.returncode != 0:
                    raise StateError("unable to mask project Codex config in review checkout")
            cloned_clean = _git_capture(
                checkout, "status", "--porcelain=v1", "--untracked-files=all"
            )
            if cloned_clean.returncode != 0 or cloned_clean.stdout:
                raise StateError("independent review checkout is not clean")
            yield checkout
    except (OSError, subprocess.SubprocessError) as exc:
        raise StateError("unable to create independent review checkout") from exc


def dispatch_attempt(
    store,
    attempt_id: str,
    fencing_token: str,
    *,
    executor: Executor,
    spark_effort: str = "low",
    timeout_seconds: int = 900,
    execute: bool = False,
    heartbeat_interval_seconds: int = 30,
) -> dict[str, Any]:
    context = store.completion_context(attempt_id)
    attempt = context["attempt"]
    issue = context["issue"] or {}
    if attempt["mode"] not in {"investigate", "repair"}:
        raise ValueError("observe mode cannot dispatch a worker")
    worktree = attempt.get("worktree")
    if not worktree:
        raise StateError("dispatch requires a persisted owned worktree")
    if isinstance(executor, SubprocessExecutor):
        executor.worktree = worktree
    store.assert_fenced(attempt_id, fencing_token)
    if attempt.get("status") != "leased" or attempt.get("session_id"):
        raise StateError("attempt already has a dispatched worker")
    if context.get("review") is not None:
        raise StateError("attempt already has a review and cannot dispatch another worker")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    if heartbeat_interval_seconds <= 0:
        raise ValueError("heartbeat_interval_seconds must be positive")
    if execute:
        try:
            model, effort, probe = choose_execution_model(executor, spark_effort=spark_effort)
        except Exception as exc:
            # A failed preflight must stop this claimed invocation. In
            # particular, auth/timeout/unknown Spark failures are not proof
            # that Luna is safe to select and must not invite a duplicate
            # worker attempt.
            terminalization = _terminalize_failure(
                store, attempt_id, fencing_token, f"Spark preflight failed: {exc}"
            )
            return {
                "attempt_id": attempt_id,
                "model": SPARK_MODEL,
                "effort": spark_effort,
                "probe": {"status": "error", "stdout": "", "stderr": str(exc)},
                "executed": False,
                "preflight_error": str(exc),
                "terminalization": terminalization,
            }
    else:
        # A dry-run is a local plan and must not launch an external model probe.
        model, effort, probe = SPARK_MODEL, spark_effort, ProcessResult("not_run")
    prompt = build_investigation_prompt(issue, mode=attempt["mode"], attempt_id=attempt_id)
    session_id = None
    prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    sandbox = "read-only" if attempt["mode"] == "investigate" else "workspace-write"
    plan = {
        "attempt_id": attempt_id,
        "model": model,
        "effort": effort,
        "session_id": session_id,
        "argv": codex_argv(model, effort, prompt, sandbox=sandbox),
        "probe": {
            "status": probe.status,
            "stdout": probe.stdout[-1000:],
            "stderr": probe.stderr[-1000:],
        },
        "executed": False,
    }
    if not execute:
        return plan
    store.mark_running(
        attempt_id,
        fencing_token,
        model=model,
        effort=effort,
        session_id=session_id,
        prompt_hash=prompt_hash,
    )
    # Ensure the lease outlives the configured timeout, then keep it alive
    # while the real subprocess is running. The subprocess adapter kills its
    # child at the deadline and returns a terminal timeout result.
    try:
        _heartbeat_with_retries(
            store,
            attempt_id,
            fencing_token,
            lease_seconds=max(900, timeout_seconds + heartbeat_interval_seconds + 60),
        )
    except FencingError:
        plan.update({"executed": False, "fenced_result": "FencingError"})
        return plan
    except Exception as exc:
        plan.update(
            {
                "executed": False,
                "result": {"status": "error", "returncode": -1, "stdout": "", "stderr": str(exc)},
                "terminalization": _terminalize_failure(
                    store, attempt_id, fencing_token, f"initial lease heartbeat failed: {exc}"
                ),
            }
        )
        return plan
    try:
        if hasattr(executor, "run_with_heartbeat"):
            result = executor.run_with_heartbeat(
                plan["argv"],
                timeout_seconds=timeout_seconds,
                heartbeat=lambda: _heartbeat_with_retries(
                    store,
                    attempt_id,
                    fencing_token,
                    lease_seconds=max(900, timeout_seconds + heartbeat_interval_seconds + 60),
                ),
                heartbeat_interval_seconds=heartbeat_interval_seconds,
            )
        else:
            result = executor.run(plan["argv"], timeout_seconds=timeout_seconds)
    except FencingError:
        # A stale/reconciled worker is fenced and must not recreate the lease.
        plan.update({"executed": True, "fenced_result": "FencingError"})
        return plan
    except Exception as exc:
        plan.update(
            {
                "executed": True,
                "result": {"status": "error", "returncode": -1, "stdout": "", "stderr": str(exc)},
                "terminalization": _terminalize_failure(
                    store, attempt_id, fencing_token, f"codex executor failed: {exc}"
                ),
            }
        )
        return plan
    # A stale worker cannot write its result. The fencing check occurs in
    # mark_running before work and must be repeated by any result writer.
    if result.session_id:
        try:
            store.update_session(
                attempt_id, fencing_token, session_id=result.session_id
            )
            plan["session_id"] = result.session_id
        except FencingError:
            # The process may have completed after explicit reconciliation.
            # Its late session/result is evidence only and cannot mutate state.
            plan["fenced_result"] = "FencingError"
        except Exception as exc:
            plan["terminalization"] = _terminalize_failure(
                store, attempt_id, fencing_token, f"session persistence failed: {exc}"
            )
    plan.update(
        {
            "executed": True,
            "result": {
                "status": result.status,
                "returncode": result.returncode,
                "stdout": result.stdout[-4000:],
                "stderr": result.stderr[-4000:],
            },
        }
    )
    if result.status in {"success", "passed"} and not result.session_id:
        plan["terminalization"] = _terminalize_failure(
            store,
            attempt_id,
            fencing_token,
            "codex exec returned success without an actual session id",
        )
        return plan
    if result.status in {"error", "timeout"}:
        # Failure is terminal for this invocation. There is deliberately no
        # automatic duplicate retry for timeout/auth/unknown CLI failures.
        try:
            store.fail_attempt(
                attempt_id,
                fencing_token,
                reason=f"codex exec {result.status}: {result.stderr[-500:]}",
            )
        except Exception as exc:
            # Reconciliation may have fenced this worker while the process
            # was finishing. Do not let its late result recreate a lease.
            plan["fenced_result"] = type(exc).__name__
    return plan


def review_argv(prompt: str) -> list[str]:
    # Reviews run in a fresh detached checkout and ignore repository/user
    # execpolicy rules so a reviewee-controlled instruction file cannot grant
    # commands or approvals to the reviewer.
    argv = codex_argv(ASTRA_REVIEW_MODEL, "medium", prompt, sandbox="read-only")
    # Disable repository project-document loading in the independent clone.
    # A repair PR can change AGENTS.md or similar files; review policy must
    # come from this controller invocation, not reviewee-controlled content.
    argv.insert(-1, "-c")
    argv.insert(-1, "project_doc_max_bytes=0")
    argv.insert(-1, "--ignore-rules")
    return argv


def _review_record(stdout: str) -> tuple[str, str, str] | None:
    """Parse only the final agent message from a Codex JSONL stream."""

    session_id_from_stream: str | None = None
    events: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except (TypeError, ValueError):
            continue
        if isinstance(event, dict):
            events.append(event)
            if event.get("type") in {"thread.started", "thread.created"}:
                candidate_session = event.get("session_id") or event.get("thread_id")
                if isinstance(candidate_session, str) and candidate_session.strip():
                    session_id_from_stream = session_id_from_stream or candidate_session.strip()
    agent_messages = [
        event["item"]
        for event in events
        if event.get("type") == "item.completed"
        and isinstance(event.get("item"), dict)
        and event["item"].get("type") == "agent_message"
        and isinstance(event["item"].get("text"), str)
    ]
    if not agent_messages:
        return None
    # Tool output, turn metadata, and earlier agent messages are evidence
    # only. Parse exactly the last completed agent_message as the final model
    # response; do not fall back to an earlier verdict-shaped event.
    try:
        candidate = json.loads(agent_messages[-1]["text"])
    except (TypeError, ValueError):
        return None
    if not isinstance(candidate, dict) or set(candidate) != {"decision", "evidence"}:
        return None
    decision = candidate.get("decision")
    evidence = candidate.get("evidence")
    if (
        decision in {"approved", "rejected", "needs_changes"}
        and isinstance(evidence, str)
        and evidence.strip()
        and isinstance(session_id_from_stream, str)
        and session_id_from_stream.strip()
    ):
        return decision, evidence.strip(), session_id_from_stream.strip()
    return None


def dispatch_review(
    store,
    attempt_id: str,
    fencing_token: str,
    *,
    executor: Executor,
    timeout_seconds: int = 600,
    execute: bool = False,
) -> dict[str, Any]:
    """Run and persist the independent Astra review only with actual output."""

    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    context = store.completion_context(attempt_id)
    store.assert_fenced(attempt_id, fencing_token)
    worktree = context["attempt"].get("worktree")
    if not worktree:
        raise StateError("review requires a persisted owned worktree")
    prompt = build_review_prompt(
        context["issue"] or {}, context["attempt"], context
    )
    argv = review_argv(prompt)
    plan: dict[str, Any] = {
        "attempt_id": attempt_id,
        "model": ASTRA_REVIEW_MODEL,
        "effort": "medium",
        "argv": argv,
        "executed": False,
    }
    if not execute:
        return plan
    if not context["attempt"].get("session_id"):
        raise ValueError("review requires a persisted repair session")
    snapshot = store.review_snapshot(attempt_id)
    existing_review = context.get("review")
    if (
        existing_review is not None
        and existing_review.get("decision") in {"rejected", "needs_changes"}
    ):
        previous_snapshot = existing_review.get("evidence_snapshot_json")
        if not previous_snapshot:
            raise StateError("nonapproval review has no immutable evidence snapshot")
        if previous_snapshot == snapshot.get("evidence_snapshot_json"):
            # A non-approval is bound to the immutable evidence it examined.
            # Re-running the same review cannot change its answer and would
            # only create an unbounded review loop; update evidence before
            # retrying.
            raise StateError("nonapproval review requires changed evidence before rerun")
    # A review does not replace the repair model/session on the attempt. Its
    # independent session is persisted in reviews after actual output parses.
    # First inspect and clone the exact clean commit. Checkout failures are
    # operator-visible state errors and never consume the repair attempt.
    result: ProcessResult
    original_worktree = executor.worktree if isinstance(executor, SubprocessExecutor) else None
    with _fresh_review_checkout(worktree, snapshot["reviewed_head_sha"]) as review_worktree:
        if isinstance(executor, SubprocessExecutor):
            executor.worktree = review_worktree
        review_attempt = dict(context["attempt"])
        review_attempt["worktree"] = review_worktree
        review_prompt = build_review_prompt(
            context["issue"] or {}, review_attempt, context
        )
        argv = review_argv(review_prompt)
        plan["argv"] = argv
        try:
            _heartbeat_with_retries(
                store,
                attempt_id, fencing_token, lease_seconds=max(900, timeout_seconds + 60)
            )
            result = executor.run(argv, timeout_seconds=timeout_seconds)
        except FencingError:
            plan.update({"executed": True, "fenced_result": "FencingError"})
            return plan
        except Exception as exc:
            plan.update(
                {
                    "executed": True,
                    "result": {"status": "error", "returncode": -1, "stdout": "", "stderr": str(exc)},
                    "review_error": f"Astra review execution failed: {exc}",
                }
            )
            return plan
        finally:
            if isinstance(executor, SubprocessExecutor):
                executor.worktree = original_worktree
    plan["executed"] = True
    plan["result"] = {
        "status": result.status,
        "returncode": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
    }
    if result.status not in {"success", "passed"}:
        plan["review_error"] = f"Astra review {result.status}: {result.stderr[-500:]}"
        return plan
    parsed = _review_record(result.stdout)
    # The adapter may expose a convenience session id, but the controller's
    # provenance source is the real thread event parsed above. Never accept a
    # model supplied field or an adapter id that disagrees with that event.
    if parsed is None:
        plan["review_error"] = "Astra review returned no explicit decision/evidence/session"
        return plan
    decision, evidence, session_id = parsed
    if result.session_id and result.session_id != session_id:
        plan["review_error"] = "Astra review session provenance disagrees with thread event"
        return plan
    try:
        store.record_review(
            attempt_id,
            fencing_token,
            model=ASTRA_REVIEW_MODEL,
            effort="medium",
            session_id=session_id,
            decision=decision,
            evidence=evidence,
            source="codex_exec",
            command=argv,
            result_status=result.status,
            verified=True,
            snapshot=snapshot,
        )
    except FencingError:
        plan["fenced_result"] = "FencingError"
        return plan
    except Exception as exc:
        plan["review_error"] = f"Astra review persistence failed: {exc}"
        return plan
    plan["review"] = {
        "decision": decision,
        "evidence": evidence,
        "session_id": session_id,
    }
    return plan


def fable_review_argv(prompt: str) -> list[str]:
    """Build a separate Claude CLI review command; never send Fable to Codex."""

    return [
        "claude",
        "--model",
        FABLE_REVIEW_MODEL,
        "--effort",
        "medium",
        "--print",
        prompt,
    ]
