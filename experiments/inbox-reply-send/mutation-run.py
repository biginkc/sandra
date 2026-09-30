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
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PROOF = ROOT / "experiments/inbox-reply-send/projection-proof.py"
STATUS_EVENTS = ROOT / "src/lib/messaging/status-events.ts"
LOG = Path("/Users/jarradhenry/Sites/BMH apps/Sandra-inbox-tmp/notes/replypersist-mutation-run-r2.log")
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
    if n == 15:
        for variant in ("channel", "org", "direction"):
            mutated_env = {**base_env, "PROJECTION_MUTATION_VARIANT": variant}
            record(handle, f"T15 mutation {variant}", execute([sys.executable, str(PROOF), "--mutated", "T15"], mutated_env))
    else:
        record(handle, f"T{n} mutation", execute([sys.executable, str(PROOF), "--mutated", f"T{n}"], base_env))


def run_t17_application_mutation(handle) -> None:
    original = STATUS_EVENTS.read_bytes()
    needle = b'    .eq("external_id", event.externalId)\n'
    if original.count(needle) != 1:
        raise RuntimeError("T17 mutation target is not unique")
    mutated = original.replace(needle, b"    // mutation: skip the legacy external-id lookup\n", 1)
    STATUS_EVENTS.write_bytes(mutated)
    try:
        command = [
            "npx", "vitest", "run", "--config", "vitest.config.ts",
            "src/lib/messaging/status-events.test.ts",
            "-t", "T17 updates a matched non-Inbox legacy row",
            "--maxWorkers=1", "--no-file-parallelism",
        ]
        record(handle, "T17 application mutation", execute(command, {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}))
    finally:
        STATUS_EVENTS.write_bytes(original)


def derive_evidence(raw: str) -> str:
    sections = raw.split("===== ")[1:]
    rows: list[str] = [
        "# Reply-persistence v5 mutation evidence (generated)",
        "",
        "This file is generated from `replypersist-mutation-run-r2.log`; failure text is copied from captured child output.",
        "",
        "| Test | Mutation run | Captured result/failure |",
        "|---|---|---|",
    ]
    for section in sections:
        header, _, body = section.partition(" =====\n")
        if header.startswith("END ") or " mutation" not in header:
            continue
        lines = [line.strip() for line in body.splitlines() if line.strip()]
        result_lines = [line for line in lines if " FAIL " in line or "Error:" in line or "ERROR:" in line or "AssertionError:" in line]
        selected = result_lines[:3] or lines[-3:]
        label = header.replace("|", "\\|")
        value = "<br>".join(line.replace("|", "\\|") for line in selected)
        rows.append(f"| {label} | applied by runner, reverted in finally | `{value}` |")
    return "\n".join(rows) + "\n"


def main() -> int:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("w", encoding="utf-8") as handle:
        handle.write("reply-persistence v5 round-2 mutation run; machine-produced raw child output\n")
        for n in range(1, 28):
            run_sql_cases(handle, n)
        run_t17_application_mutation(handle)
    EVIDENCE.write_text(derive_evidence(LOG.read_text(encoding="utf-8")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
