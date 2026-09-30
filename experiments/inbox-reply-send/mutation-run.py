#!/usr/bin/env python3
"""Run the reply-persistence proof suite and capture mutation evidence.

The SQL proof harness owns each database mutation's install/revert boundary.
This runner records the complete child stdout/stderr, including the real
failure text, then derives the evidence markdown from that raw log.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PROOF = ROOT / "experiments/inbox-reply-send/projection-proof.py"
STATUS_EVENTS = ROOT / "src/lib/messaging/status-events.ts"
HANDLER = ROOT / "experiments/inbox-reply-send-worker/handler.mjs"
T18_INTEGRATION = ROOT / "src/app/api/cron/sequence-tick/route.queue.integration.test.ts"
LOCAL_INTEGRATION = ROOT / "experiments/inbox-reply-send/run-local-integration.mjs"
WORKER_TEST = ROOT / "experiments/inbox-reply-send-worker/restate-retry.test.mjs"
WORKER_CORE = ROOT / "experiments/inbox-reply-send-worker/core.mjs"
WORKER_SERVICE = ROOT / "experiments/inbox-reply-send-worker/service.mjs"
WORKER_DOCKERFILE = ROOT / "experiments/inbox-reply-send-worker/Dockerfile"
WORKER_HANDLER = ROOT / "experiments/inbox-reply-send-worker/handler.mjs"
LOCAL_DB_RETRY = ROOT / "experiments/inbox-reply-send-worker/restate-retry-local-db.py"
PROVIDER_FIX = ROOT / "experiments/inbox-reply-send/provider-fix-proof.py"
LOG = Path("/Users/jarradhenry/Sites/BMH apps/Sandra-inbox-tmp/notes/replypersist-mutation-run-r4.log")
EVIDENCE = Path("/Users/jarradhenry/Sites/BMH apps/Sandra-inbox-tmp/notes/replypersist-mutation-evidence.md")


def execute(command: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=ROOT, text=True, capture_output=True, env=env)


def record(handle, label: str, result: subprocess.CompletedProcess[str]) -> None:
    handle.write(f"\n===== {label} =====\n")
    handle.write("$ " + " ".join(result.args) + "\n")
    handle.write(f"exit={result.returncode}\n--- stdout ---\n{result.stdout}")
    handle.write(f"--- stderr ---\n{result.stderr}\n===== END {label} =====\n")
    handle.flush()


def run_sql_cases(handle, n: int) -> None:
    base_env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PROJECTION_VERBOSE_FAILURES": "1"}
    command = [sys.executable, str(PROOF), f"T{n}"]
    record(handle, f"T{n} baseline", execute(command, base_env))
    if n == 17:
        return
    if n == 4:
        run_t4_application(handle)
        return
    if n == 16:
        run_t16_application(handle)
        return
    if n == 15:
        for variant in ("channel", "org", "direction"):
            mutated_env = {**base_env, "PROJECTION_MUTATION_VARIANT": variant}
            record(handle, f"T15 mutation {variant}", execute([sys.executable, str(PROOF), "--mutated", "T15"], mutated_env))
    else:
        record(handle, f"T{n} mutation", execute([sys.executable, str(PROOF), "--mutated", f"T{n}"], base_env))
    if n in {18, 23}:
        run_local_integration(handle, n)


def run_local_integration(handle, n: int) -> None:
    command = ["node", str(LOCAL_INTEGRATION), "--test", f"T{n}"]
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    record(handle, f"T{n} integration baseline", execute(command, env))
    if n == 18:
        original = T18_INTEGRATION.read_bytes()
        needle = b'''      metadata: {
        inboxReply: { attemptId: "t18-inbox-attempt", operationId: "t18-inbox-operation" },
      },
'''
        replacement = b'''      metadata: {
        inboxReply: { attemptId: "t18-inbox-attempt", operationId: "t18-inbox-operation" },
        providerAttempt: {
          pendingAt: new Date(SAFE_NOW.getTime() - 20 * 60_000).toISOString(),
          maxPendingMs: 15 * 60_000,
        },
      },
'''
        if original.count(needle) != 1:
            raise RuntimeError("T18 integration mutation target is not unique")
        T18_INTEGRATION.write_bytes(original.replace(needle, replacement, 1))
        try:
            record(handle, "T18 integration mutation", execute(command, env))
        finally:
            T18_INTEGRATION.write_bytes(original)
    else:
        record(handle, "T23 integration mutation", execute(command + ["--mutated", "T23"], env))


def run_t4_application(handle) -> None:
    command = ["node", "--test", "experiments/inbox-reply-send-worker/handler.test.mjs"]
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    record(handle, "T4 handler baseline", execute(command, env))
    original = HANDLER.read_bytes()
    needle = b"""      const dispatch = await ctx.run(`dispatch:${attemptId}`, async () => {
        const result = await runner.dispatchAttempt(orgId, operationId, attemptId);
        if (result.kind !== 'settled' && result.kind !== 'dispatched') {
          throw Error(`reply attempt ${attemptId} not yet settled: ${result.kind}${result.reason ? `(${result.reason})` : ''}`);
        }
        return result;
      });
      const outcome = dispatch.kind === 'settled'
        ? dispatch
        : await ctx.run(`persist:${attemptId}`, async () => runner.persistAttempt(orgId, operationId, attemptId, dispatch));
"""
    replacement = b"""      const outcome = await ctx.run(`dispatch:${attemptId}`, async () => {
        const result = await runner.dispatchAttempt(orgId, operationId, attemptId);
        if (result.kind !== 'settled' && result.kind !== 'dispatched') {
          throw Error(`reply attempt ${attemptId} not yet settled: ${result.kind}${result.reason ? `(${result.reason})` : ''}`);
        }
        return result.kind === 'settled'
          ? result
          : await runner.persistAttempt(orgId, operationId, attemptId, result);
      });
"""
    if original.count(needle) != 1:
        raise RuntimeError("T4 handler mutation target is not unique")
    mutant = original.replace(needle, replacement, 1)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".handler-t4-mutant-", suffix=".mjs", dir=HANDLER.parent, delete=False) as temp:
            temp.write(mutant)
            temp_path = Path(temp.name)
        record(handle, "T4 handler mutation", execute(command, {**env, "REPLY_PERSIST_T4_HANDLER_MODULE": str(temp_path)}))
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def run_t16_application(handle) -> None:
    command = [
        "npx", "vitest", "run", "--config", "vitest.config.ts",
        "src/lib/messaging/status-events.test.ts",
        "-t", "T16 forwards an unmatched delivered event before the reply row exists",
        "--maxWorkers=1", "--no-file-parallelism",
    ]
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    record(handle, "T16 application baseline", execute(command, env))
    original = STATUS_EVENTS.read_bytes()
    needle = b"""  if (!message) {
    if (event.kind === \"delivered\" || event.kind === \"failed\") {
      return forwardInboxReplyCallback(providerId, event);
    }
    return \"unknown\";
  }
"""
    replacement = b"""  if (!message) {
    // mutation: forward only rows already carrying the marker
    return \"unknown\";
  }
"""
    if original.count(needle) != 1:
        raise RuntimeError("T16 mutation target is not unique")
    STATUS_EVENTS.write_bytes(original.replace(needle, replacement, 1))
    try:
        record(handle, "T16 application mutation", execute(command, env))
    finally:
        STATUS_EVENTS.write_bytes(original)


def run_t17_application(handle) -> None:
    original = STATUS_EVENTS.read_bytes()
    needle = b'    .eq("external_id", event.externalId)\n'
    if original.count(needle) != 1:
        raise RuntimeError("T17 mutation target is not unique")
    mutated = original.replace(needle, b"    // mutation: skip the legacy external-id lookup\n", 1)
    command = [
        "npx", "vitest", "run", "--config", "vitest.config.ts",
        "src/lib/messaging/status-events.test.ts",
        "-t", "T17 updates a matched non-Inbox legacy row",
        "--maxWorkers=1", "--no-file-parallelism",
    ]
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    record(handle, "T17 application baseline", execute(command, env))
    STATUS_EVENTS.write_bytes(mutated)
    try:
        record(handle, "T17 application mutation", execute(command, env))
    finally:
        STATUS_EVENTS.write_bytes(original)


def run_worker_locals(handle) -> None:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    baseline = ["node", "--test", str(WORKER_TEST)]
    record(handle, "T-R1/T-R6/T-R7/T-R8 local baseline", execute(baseline, env))
    mutations = [
        ("T-R1 mutation", WORKER_SERVICE, b"    options: inboxReplySendServiceOptions,\n", b"    // mutation: omit service options\n", "T-R1"),
        ("T-R6 mutation", WORKER_CORE, b"BigInt(entry.generation) >= 150n", b"BigInt(entry.generation) > 150n", "T-R6"),
        ("T-R7 mutation", WORKER_DOCKERFILE, b"core.mjs runner.mjs server.mjs handler.mjs service.mjs", b"core.mjs runner.mjs server.mjs service.mjs", "T-R7"),
        ("T-R8 mutation", WORKER_HANDLER, b"throw Error('Invalid reply dispatch request');", b"throw Object.assign(new Error('Invalid reply dispatch request'), { terminal: true });", "T-R8"),
    ]
    for label, path, needle, replacement, test_name in mutations:
        original = path.read_bytes()
        if original.count(needle) != 1:
            raise RuntimeError(f"{label} mutation target is not unique")
        path.write_bytes(original.replace(needle, replacement, 1))
        try:
            record(handle, label, execute(["node", "--test", str(WORKER_TEST), "--test-name-pattern", test_name], env))
        finally:
            path.write_bytes(original)


def run_provider_fixes(handle) -> None:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    route = [
        "npx", "vitest", "run", "--config", "vitest.config.ts",
        "src/app/api/webhooks/sendillo/reply-status/route.test.ts",
        "-t", "returns a non-2xx response when reconciliation is busy",
        "--maxWorkers=1", "--no-file-parallelism",
    ]
    record(handle, "B1 route baseline", execute(route, env))
    record(handle, "B2 lock-timeout baseline", execute([sys.executable, str(PROVIDER_FIX)], env))
    record(handle, "B2 lock-timeout mutation", execute([sys.executable, str(PROVIDER_FIX), "--mutated"], env))
    record(handle, "B4 source-record baseline", execute([sys.executable, str(PROVIDER_FIX), "--b4"], env))


def run_restate_local_db(handle) -> None:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    for name in ("T-R12", "T-R12b", "T-R13"):
        record(handle, f"{name} local-db baseline", execute([sys.executable, str(LOCAL_DB_RETRY), name], env))
        record(handle, f"{name} local-db mutation", execute([sys.executable, str(LOCAL_DB_RETRY), name, "--mutated"], env))


REAL_NOT_RUN = {
    "T-R2": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R3": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R4": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R5a": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R5b": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R9": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R10": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R11": "Railway/provider execution is forbidden by Round 4",
    "T-R13": "Restate engine requires Docker for REAL half; Docker is forbidden by Round 4",
}


def derive_evidence(raw: str) -> str:
    sections = raw.split("===== ")[1:]
    rows: list[str] = [
        "# Reply-persistence v5 mutation evidence (generated)",
        "",
        "This file is generated from `replypersist-mutation-run-r4.log`; failure text is copied from captured child output.",
        "",
        "| Test | Executed | Mechanism | Captured mutated failure |",
        "|---|---|---|---|",
    ]
    seen = set()
    for section in sections:
        header, _, body = section.partition(" =====\n")
        if header.startswith("END ") or " mutation" not in header:
            continue
        lines = [line.strip() for line in body.splitlines() if line.strip()]
        result_lines = [line for line in lines if " FAIL " in line or "Error:" in line or "ERROR:" in line or "AssertionError:" in line or "expected" in line.lower()]
        selected = result_lines[:3] or lines[-3:]
        test = header.split()[0]
        seen.add(test)
        label = header.replace("|", "\\|")
        value = "<br>".join(line.replace("|", "\\|") for line in selected)
        executed = "NOT RUN" if "NOT RUN" in header or "NOT RUN" in body or "could not connect" in body or "fixture.*unavailable" in body else "EXECUTED"
        rows.append(f"| {test} | {executed} | {label} | `{value}` |")
    for n in range(1, 28):
        test = f"T{n}"
        if test not in seen:
            rows.append(f"| {test} | NOT RUN | no mutation record | `no captured run` |")
    for test, reason in REAL_NOT_RUN.items():
        rows.append(f"| {test} | NOT RUN | REAL ruling row | `{reason}` |")
    for test in ("T-R5c",):
        rows.append(f"| {test} | NOT RUN | not in Round 4 local execution set | `not requested for this round` |")
    return "\n".join(rows) + "\n"


def main() -> int:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("w", encoding="utf-8") as handle:
        handle.write("reply-persistence v5 round-4 mutation run; machine-produced raw child output\n")
        for n in range(1, 28):
            run_sql_cases(handle, n)
        run_t17_application(handle)
        run_worker_locals(handle)
        run_provider_fixes(handle)
        run_restate_local_db(handle)
    EVIDENCE.write_text(derive_evidence(LOG.read_text(encoding="utf-8")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
