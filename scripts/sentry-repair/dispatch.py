"""Bounded codex exec dispatch with preflight model selection and no retries."""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from prompts import build_investigation_prompt, build_review_prompt
from validation import validate_model_outcome


SPARK_MODEL = "gpt-5.3-codex-spark"
LUNA_MODEL = "gpt-5.6-luna"
ASTRA_REVIEW_MODEL = "gpt-6-astra"
FABLE_REVIEW_MODEL = "claude-fable-5-1"


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
        "--skip-git-repo-check",
        "--json",
        prompt,
    ]


class SubprocessExecutor:
    """Real CLI adapter; callers must opt into execute mode explicitly."""

    def __init__(self, executable: str = "codex") -> None:
        self.executable = executable

    def probe(self, model: str, effort: str) -> ProcessResult:
        probe_prompt = (
            "This is a model availability probe. Return exactly MODEL_PROBE_OK. "
            "Do not inspect files, edit files, or take any external action."
        )
        argv = codex_argv(model, effort, probe_prompt)
        # A probe is read-only by instruction and by the CLI sandbox flag.
        argv[argv.index("--sandbox") + 1] = "read-only"
        try:
            result = subprocess.run(
                [self.executable, *argv[1:]],
                text=True,
                capture_output=True,
                timeout=60,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            return ProcessResult("timeout", str(exc.stdout or ""), str(exc.stderr or ""), -1)
        except OSError as exc:
            return ProcessResult("error", "", str(exc), -1)
        status = "available" if result.returncode == 0 else "error"
        return ProcessResult(status, result.stdout, result.stderr, result.returncode)

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
            if isinstance(event, dict):
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
                    process.kill()
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
                        process.kill()
                        process.wait()
                        stdout, stderr = collect()
                        return ProcessResult(
                            "stale",
                            stdout,
                            f"{stderr}\nheartbeat fenced: {exc}",
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
    store.assert_fenced(attempt_id, fencing_token)
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    if heartbeat_interval_seconds <= 0:
        raise ValueError("heartbeat_interval_seconds must be positive")
    if execute:
        model, effort, probe = choose_execution_model(executor, spark_effort=spark_effort)
    else:
        # A dry-run is a local plan and must not launch an external model probe.
        model, effort, probe = SPARK_MODEL, spark_effort, ProcessResult("not_run")
    prompt = build_investigation_prompt(issue, mode=attempt["mode"], fencing_token=fencing_token)
    session_id = f"codex-{uuid.uuid4()}"
    prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    plan = {
        "attempt_id": attempt_id,
        "model": model,
        "effort": effort,
        "session_id": session_id,
        "argv": codex_argv(model, effort, prompt),
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
    store.heartbeat(
        attempt_id,
        fencing_token,
        lease_seconds=max(900, timeout_seconds + heartbeat_interval_seconds + 60),
    )
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
    except Exception:
        # A stale/reconciled worker is fenced and must not recreate the lease.
        raise
    # A stale worker cannot write its result. The fencing check occurs in
    # mark_running before work and must be repeated by any result writer.
    if result.session_id:
        try:
            store.update_session(
                attempt_id, fencing_token, session_id=result.session_id
            )
            plan["session_id"] = result.session_id
        except Exception as exc:
            # The process may have completed after explicit reconciliation.
            # Its late session/result is evidence only and cannot mutate state.
            plan["fenced_result"] = type(exc).__name__
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
            session_id_from_stream = session_id_from_stream or event.get("session_id") or event.get("thread_id")
    for payload in reversed(events):
        candidate = payload.get("review") if isinstance(payload.get("review"), dict) else payload
        item = payload.get("item")
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            try:
                candidate = json.loads(item["text"])
            except (TypeError, ValueError):
                candidate = payload
        decision = candidate.get("decision") if isinstance(candidate, dict) else None
        evidence = candidate.get("evidence") if isinstance(candidate, dict) else None
        session_id = payload.get("session_id") or payload.get("thread_id") or session_id_from_stream
        if isinstance(candidate, dict):
            session_id = session_id or candidate.get("session_id") or candidate.get("thread_id")
        if decision in {"approved", "rejected", "needs_changes"} and isinstance(evidence, str) and evidence.strip() and isinstance(session_id, str) and session_id.strip():
            return decision, evidence.strip(), session_id.strip()
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
    # A review does not replace the repair model/session on the attempt. Its
    # independent session is persisted in reviews after actual output parses.
    store.heartbeat(attempt_id, fencing_token, lease_seconds=max(900, timeout_seconds + 60))
    result = executor.run(argv, timeout_seconds=timeout_seconds)
    plan["executed"] = True
    plan["result"] = {
        "status": result.status,
        "returncode": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
    }
    if result.status not in {"success", "passed"}:
        store.fail_attempt(
            attempt_id,
            fencing_token,
            reason=f"Astra review {result.status}: {result.stderr[-500:]}",
        )
        return plan
    parsed = _review_record(result.stdout)
    session_id = result.session_id or (parsed[2] if parsed else None)
    if parsed is None or not session_id:
        store.fail_attempt(
            attempt_id,
            fencing_token,
            reason="Astra review returned no explicit decision/evidence/session",
        )
        return plan
    decision, evidence, _ = parsed
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
    )
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
