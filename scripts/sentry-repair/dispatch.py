"""Bounded codex exec dispatch with preflight model selection and no retries."""

from __future__ import annotations

import hashlib
import json
import subprocess
import uuid
from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from prompts import build_investigation_prompt
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


def codex_argv(model: str, effort: str, prompt: str) -> list[str]:
    if model not in {SPARK_MODEL, LUNA_MODEL, ASTRA_REVIEW_MODEL}:
        raise ValueError(f"unsupported model {model}")
    if effort not in {"low", "medium", "xhigh"}:
        raise ValueError(f"unsupported reasoning effort {effort}")
    if model == LUNA_MODEL and effort != "xhigh":
        raise ValueError("Luna fallback is restricted to xhigh")
    if model == ASTRA_REVIEW_MODEL and effort != "medium":
        raise ValueError("Astra review is restricted to medium")
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
        "workspace-write",
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
        try:
            result = subprocess.run(
                argv,
                text=True,
                capture_output=True,
                timeout=timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            return ProcessResult("timeout", str(exc.stdout or ""), str(exc.stderr or ""), -1)
        except OSError as exc:
            return ProcessResult("error", "", str(exc), -1)
        status = "success" if result.returncode == 0 else "error"
        return ProcessResult(status, result.stdout, result.stderr, result.returncode)


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
) -> dict[str, Any]:
    context = store.completion_context(attempt_id)
    attempt = context["attempt"]
    issue = context["issue"] or {}
    if attempt["mode"] not in {"investigate", "repair"}:
        raise ValueError("observe mode cannot dispatch a worker")
    store.assert_fenced(attempt_id, fencing_token)
    model, effort, probe = choose_execution_model(executor, spark_effort=spark_effort)
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
    result = executor.run(plan["argv"], timeout_seconds=timeout_seconds)
    # A stale worker cannot write its result. The fencing check occurs in
    # mark_running before work and must be repeated by any result writer.
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
        store.fail_attempt(
            attempt_id,
            fencing_token,
            reason=f"codex exec {result.status}: {result.stderr[-500:]}",
        )
    return plan


def review_argv(prompt: str) -> list[str]:
    return codex_argv(ASTRA_REVIEW_MODEL, "medium", prompt)


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
