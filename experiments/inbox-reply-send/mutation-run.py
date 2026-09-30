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
REPLY_STATUS_ROUTE = ROOT / "src/app/api/webhooks/sendillo/reply-status/route.ts"
PROJECTION_MIGRATION = ROOT / "supabase/migrations/20260930040250_inbox_reply_message_projection.sql"
WORKER_TEST = ROOT / "experiments/inbox-reply-send-worker/restate-retry.test.mjs"
WORKER_CORE = ROOT / "experiments/inbox-reply-send-worker/core.mjs"
WORKER_SERVICE = ROOT / "experiments/inbox-reply-send-worker/service.mjs"
WORKER_DOCKERFILE = ROOT / "experiments/inbox-reply-send-worker/Dockerfile"
WORKER_HANDLER = ROOT / "experiments/inbox-reply-send-worker/handler.mjs"
WORKER_RUNNER = ROOT / "experiments/inbox-reply-send-worker/runner.mjs"
WORKER_TRANSPORT = ROOT / "experiments/inbox-reply-send-worker/vendor/test-transport.mjs"
LOCAL_DB_RETRY = ROOT / "experiments/inbox-reply-send-worker/restate-retry-local-db.py"
PROVIDER_FIX = ROOT / "experiments/inbox-reply-send/provider-fix-proof.py"
PROVIDER_FIX_MINIMAL = ROOT / "experiments/inbox-reply-send/provider-fix-minimal.py"
LOG = Path("/Users/jarradhenry/Sites/BMH apps/Sandra-inbox-tmp/notes/replypersist-mutation-run-r5.log")
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
    if n == 10:
        major_probe = execute([
            "psql", "-XqAt", "-h", base_env.get("PROJECTION_PGHOST", "/tmp/sandra-reply-persist-pg.pPmk5e/socket"),
            "-p", base_env.get("PROJECTION_PGPORT", "55436"), "-U", base_env.get("PROJECTION_PGUSER", "postgres"),
            "-d", base_env.get("PROJECTION_PGDATABASE", "postgres"), "-c", "SELECT current_setting('server_version_num')::int/10000;",
        ], base_env)
        if major_probe.returncode == 0 and major_probe.stdout.strip() != "17":
            major = major_probe.stdout.strip()
            skipped = subprocess.CompletedProcess(["T10", "SKIP"], 0, f"T10 SKIP: granted tuple-lock assertion is pinned to PostgreSQL major 17; observed major {major}\n", "")
            record(handle, f"T10 baseline SKIP PostgreSQL major {major}", skipped)
            record(handle, f"T10 mutation SKIP PostgreSQL major {major}", skipped)
            return
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
        str(ROOT / "node_modules/.bin/vitest"), "run", "--config", "vitest.config.ts",
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
        str(ROOT / "node_modules/.bin/vitest"), "run", "--config", "vitest.config.ts",
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
    record(handle, "T-R1/T-R5c/T-R6/T-R7/T-R8 local baseline", execute(baseline, env))
    mutations = [
        ("T-R1 mutation", WORKER_SERVICE, b"    options: inboxReplySendServiceOptions,\n", b"    // mutation: omit service options\n", "T-R1"),
        ("T-R6 Number mutation", WORKER_CORE, b"const loggedGeneration = generation;", b"const loggedGeneration = Number(generation);", "T-R6"),
        ("T-R6 modulo-boundary mutation", WORKER_CORE, b"body.status === 'PreviouslyAccepted' && generation >= 150n", b"body.status === 'PreviouslyAccepted' && generation % 150n === 0n", "T-R6"),
        ("T-R7 mutation", WORKER_DOCKERFILE, b"core.mjs runner.mjs server.mjs handler.mjs service.mjs", b"core.mjs runner.mjs server.mjs service.mjs", "T-R7"),
        ("T-R8 RunOptions mutation", WORKER_HANDLER, b"const dispatch = await ctx.run(`dispatch:${attemptId}`, async () => {", b"const dispatch = await ctx.run(`dispatch:${attemptId}`, { maxRetryAttempts: 3 }, async () => {", "T-R8"),
    ]
    for label, path, needle, replacement, test_name in mutations:
        original = path.read_bytes()
        if original.count(needle) != 1:
            raise RuntimeError(f"{label} mutation target is not unique")
        path.write_bytes(original.replace(needle, replacement, 1))
        try:
            record(handle, label, execute(["node", "--test", "--test-name-pattern", test_name, str(WORKER_TEST)], env))
        finally:
            path.write_bytes(original)

    original = WORKER_HANDLER.read_bytes()
    import_needle = b"export function createRunHandler({ runner, pool }) {\n"
    terminal_needle = b"throw Error('Invalid reply dispatch request');"
    if original.count(import_needle) != 1 or original.count(terminal_needle) != 1:
        raise RuntimeError("T-R8 TerminalError mutation target is not unique")
    terminal_mutation = original.replace(import_needle, b"import { TerminalError } from '@restatedev/restate-sdk';\n" + import_needle, 1).replace(terminal_needle, b"throw new TerminalError('Invalid reply dispatch request');", 1)
    WORKER_HANDLER.write_bytes(terminal_mutation)
    try:
        record(handle, "T-R8 TerminalError mutation", execute(["node", "--test", "--test-name-pattern", "T-R8", str(WORKER_TEST)], env))
    finally:
        WORKER_HANDLER.write_bytes(original)

    original = WORKER_TRANSPORT.read_bytes()
    transport_needle = b"    signal.throwIfAborted();\n"
    if original.count(transport_needle) != 1:
        raise RuntimeError("T-R5c fixture mutation target is not unique")
    WORKER_TRANSPORT.write_bytes(original.replace(transport_needle, b"    // mutation: omit fixture deadline check\n", 1))
    try:
        record(handle, "T-R5c mutation", execute(["node", "--test", "--test-name-pattern", "T-R5c", str(WORKER_TEST)], env))
    finally:
        WORKER_TRANSPORT.write_bytes(original)


def run_provider_fixes(handle) -> None:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    route = [
        str(ROOT / "node_modules/.bin/vitest"), "run", "--config", "vitest.config.ts",
        "src/app/api/webhooks/sendillo/reply-status/route.test.ts",
        "-t", "returns a non-2xx response when reconciliation is busy",
        "--maxWorkers=1", "--no-file-parallelism",
    ]
    record(handle, "B1 route baseline", execute(route, env))
    route_original = REPLY_STATUS_ROUTE.read_bytes()
    busy_branch = b'''    if (data && typeof data === "object" && !Array.isArray(data) && (data as { kind?: unknown }).kind === "busy") {
      reportError(new Error("reply reconciliation busy"), {
        tags: { surface: "sendillo_reply_status_webhook_reconcile" },
        extra: { externalId: event.externalId, terminal: event.terminal },
      });
      return NextResponse.json({ error: "reconcile busy" }, { status: 500 });
    }
'''
    if route_original.count(busy_branch) != 1:
        raise RuntimeError("B1 busy-route mutation target is not unique")
    REPLY_STATUS_ROUTE.write_bytes(route_original.replace(busy_branch, b"    // mutation: busy reconcile falls through to 200\n", 1))
    try:
        record(handle, "B1 route mutation", execute(route, env))
    finally:
        REPLY_STATUS_ROUTE.write_bytes(route_original)
    record(handle, "B2 lock-timeout baseline", execute([sys.executable, str(PROVIDER_FIX)], env))
    record(handle, "B2 lock-timeout mutation", execute([sys.executable, str(PROVIDER_FIX), "--mutated"], env))
    record(handle, "B2 minimal disposable PostgreSQL baseline", execute([sys.executable, str(PROVIDER_FIX_MINIMAL)], env))
    record(handle, "B2 minimal disposable PostgreSQL mutation", execute([sys.executable, str(PROVIDER_FIX_MINIMAL), "--mutated"], env))
    record(handle, "B4 source-record baseline", execute([sys.executable, str(PROVIDER_FIX), "--b4"], env))
    migration_original = PROJECTION_MIGRATION.read_bytes()
    comment_block = b''' -- Deliberately omit query_canceled: cancellation aborts this transaction and
 -- rolls back any tries bump; a cancelled drain must not count as a retry.
'''
    if migration_original.count(comment_block) != 1:
        raise RuntimeError("B4 source-record mutation target is not unique")
    PROJECTION_MIGRATION.write_bytes(migration_original.replace(comment_block, b"", 1))
    try:
        record(handle, "B4 source-record mutation", execute([sys.executable, str(PROVIDER_FIX), "--b4"], env))
    finally:
        PROJECTION_MIGRATION.write_bytes(migration_original)


def run_restate_local_db(handle) -> None:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    for name in ("T-R12", "T-R12b", "T-R13"):
        record(handle, f"{name} local-db baseline", execute([sys.executable, str(LOCAL_DB_RETRY), name], env))
        if name == "T-R12":
            original = WORKER_RUNNER.read_bytes()
            needle = b"          return { kind: 'not_sent', reason: code ?? 'start_dispatch_failed' };"
            replacement = b"          return settled('rejected_unsent');"
            if original.count(needle) != 1:
                raise RuntimeError("T-R12 runner mutation target is not unique")
            with tempfile.NamedTemporaryFile(prefix=".runner-t-r12-", suffix=".mjs", dir=WORKER_RUNNER.parent, delete=False) as mutant:
                mutant.write(original.replace(needle, replacement, 1))
                mutant_path = Path(mutant.name)
            try:
                record(handle, f"{name} local-db mutation", execute([sys.executable, str(LOCAL_DB_RETRY), name], {**env, "REPLY_PERSIST_RUNNER_MODULE": str(mutant_path)}))
            finally:
                mutant_path.unlink(missing_ok=True)
        elif name == "T-R13":
            original = WORKER_RUNNER.read_bytes()
            needle = b"          if (code === 'INBOX_REPLY_SENDER_BUSY') return { kind: 'deferred' };\n"
            replacement = needle + b"          if (code === 'INBOX_REPLY_REQUESTER_UNAUTHORIZED') return settled('rejected_unsent');\n"
            if original.count(needle) != 1:
                raise RuntimeError("T-R13 runner mutation target is not unique")
            with tempfile.NamedTemporaryFile(prefix=".runner-t-r13-", suffix=".mjs", dir=WORKER_RUNNER.parent, delete=False) as mutant:
                mutant.write(original.replace(needle, replacement, 1))
                mutant_path = Path(mutant.name)
            try:
                record(handle, f"{name} local-db mutation", execute([sys.executable, str(LOCAL_DB_RETRY), name], {**env, "REPLY_PERSIST_RUNNER_MODULE": str(mutant_path)}))
            finally:
                mutant_path.unlink(missing_ok=True)
        else:
            record(handle, f"{name} local-db mutation", execute([sys.executable, str(LOCAL_DB_RETRY), name], {**env, "RESTATE_LOCAL_DB_FIXTURE_VARIANT": "T-R12b-drop-post-marker"}))


REAL_NOT_RUN = {
    "T-R2": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R3": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R4": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R5a": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R5b": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R9": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R10": "Restate engine requires Docker; Docker is forbidden by Round 4",
    "T-R11": "Railway/provider execution is forbidden by Round 4",
    "T-R8 REAL": "Restate engine requires Docker for REAL half; Docker is forbidden by Round 4",
    "T-R13 REAL": "Restate engine requires Docker for REAL half; Docker is forbidden by Round 4",
}


def derive_evidence(raw: str) -> str:
    sections = raw.split("===== ")[1:]
    rows: list[str] = [
        "# Reply-persistence v5 mutation evidence (generated)",
        "",
        "This file is generated from `replypersist-mutation-run-r5.log`; failure text is copied from captured child output.",
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
        executed = "SKIP" if "SKIP" in header or "SKIP" in body else ("NOT RUN" if "NOT RUN" in header or "NOT RUN" in body or "could not connect" in body or "No such file or directory" in body or "PROJECTION_PGHOST is required" in body or "ERR_MODULE_NOT_FOUND" in body or "Cannot find package" in body else "EXECUTED")
        rows.append(f"| {test} | {executed} | {label} | `{value}` |")
    for n in range(1, 28):
        test = f"T{n}"
        if test not in seen:
            rows.append(f"| {test} | NOT RUN | no mutation record | `no captured run` |")
    for test, reason in REAL_NOT_RUN.items():
        rows.append(f"| {test} | NOT RUN | REAL ruling row | `{reason}` |")
    return "\n".join(rows) + "\n"


def main() -> int:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("w", encoding="utf-8") as handle:
        handle.write("reply-persistence v5 round-5 mutation run; machine-produced raw child output\n")
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
