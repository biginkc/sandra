"""Bounded codex exec dispatch with preflight model selection and no retries."""

from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass
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
        "SANDRA_FENCING_TOKEN",
    }
)


def kill_process_group(process) -> None:
    """Kill a Codex process and descendants without shell invocation."""

    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (AttributeError, OSError, ProcessLookupError):
        process.kill()


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

    def __init__(self, executable: str = "codex", worktree: str | None = None) -> None:
        self.executable = executable
        self.worktree = worktree

    @staticmethod
    def _worker_environment() -> dict[str, str]:
        """Keep model auth while excluding provider and production secrets."""

        return {
            key: value
            for key, value in os.environ.items()
            if key not in _PRODUCTION_SECRET_ENV
        }

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
                    stdout=stdout_file,
                    stderr=stderr_file,
                    cwd=self.worktree,
                    start_new_session=True,
                    env=self._worker_environment(),
                )
            except OSError as exc:
                return ProcessResult("error", "", str(exc), -1)

            def collect() -> tuple[str, str]:
                stdout_file.flush()
                stderr_file.flush()
                stdout_file.seek(0)
                stderr_file.seek(0)
                return stdout_file.read(), stderr_file.read()

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
                    except Exception as exc:
                        # Reconciliation can fence a worker while its child
                        # is still running. Kill it before returning.
                        kill_process_group(process)
                        process.wait()
                        stdout, stderr = collect()
                        return ProcessResult(
                            "stale" if isinstance(exc, FencingError) else "error",
                            stdout,
                            f"{stderr}\nheartbeat {'fenced' if isinstance(exc, FencingError) else 'failed'}: {exc}",
                            process.returncode if process.returncode is not None else -1,
                            self._session_id(stdout),
                        )
                    next_heartbeat = now + heartbeat_interval_seconds
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
        store.heartbeat(
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
                heartbeat=lambda: store.heartbeat(
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
    return codex_argv(ASTRA_REVIEW_MODEL, "medium", prompt, sandbox="read-only")


def _review_record(stdout: str) -> tuple[str, str, str] | None:
    """Parse an explicit model review JSON result, never invent a decision."""

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
    for payload in reversed(events):
        candidate = payload.get("review") if isinstance(payload.get("review"), dict) else payload
        item = payload.get("item")
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            try:
                candidate = json.loads(item["text"])
            except (TypeError, ValueError):
                candidate = payload
        if not isinstance(candidate, dict) or set(candidate) != {"decision", "evidence"}:
            continue
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
    if isinstance(executor, SubprocessExecutor):
        executor.worktree = worktree
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
    # A review does not replace the repair model/session on the attempt. Its
    # independent session is persisted in reviews after actual output parses.
    try:
        store.heartbeat(
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
