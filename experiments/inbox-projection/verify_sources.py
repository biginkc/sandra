#!/usr/bin/env python3
"""Verify retained fixture sources without executing SQL, Docker or proof scripts."""
import ast
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def verify_file(directory: Path, name: str, expected: str) -> None:
    if Path(name).name != name:
        raise ValueError(f"Manifest path must be a filename: {name}")
    actual = hashlib.sha256((directory / name).read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError(f"Retained source hash mismatch: {name}")


def main() -> None:
    vendor = ROOT / "fixture" / "vendor"
    entries = json.loads((vendor / "manifest.json").read_text())
    seen = set()
    for entry in entries:
        name = entry["file"]
        if name in seen:
            raise ValueError(f"Duplicate executable source: {name}")
        seen.add(name)
        verify_file(vendor, name, entry["sha256"])
        if "upstream_file" in entry:
            verify_file(vendor, entry["upstream_file"], entry["upstream_sha256"])

    licenses = vendor / "licenses"
    records = json.loads((licenses / "manifest.json").read_text())["licenses"]
    for record in records:
        verify_file(licenses, record["file"], record["sha256"])

    # Current maintained-model receipts bind the tested SQL and harness sources.
    maintained = ROOT / "maintained-model"
    if maintained.exists():
        for receipt, bindings in (
            ("evidence.json", {"setup.sql": "setup_sha256", "run.py": "runner_sha256"}),
            ("queue-evidence.json", {"queue.sql": "queue_sql_sha256", "queue-proof.py": "runner_sha256"}),
        ):
            recorded = json.loads((maintained / receipt).read_text())
            for name, key in bindings.items():
                verify_file(maintained, name, recorded[key])
        expiry = json.loads((maintained / "expiry-evidence.json").read_text())
        for name, digest in expiry["source_hashes"].items():
            verify_file(maintained, name, digest)

    parent = ROOT / "parent-capture"
    if parent.exists():
        for receipt, runner in (("evidence.json", "run.py"), ("concurrency-evidence.json", "concurrency.py")):
            recorded = json.loads((parent / receipt).read_text())
            verify_file(parent, "setup.sql", recorded["setup_sha256"])
            verify_file(parent, runner, recorded["runner_sha256"])

    safety = ROOT / "safety-capture"
    if safety.exists():
        for receipt, runner in (("evidence.json", "run.py"), ("concurrency-evidence.json", "concurrency.py")):
            recorded = json.loads((safety / receipt).read_text())
            verify_file(safety, "setup.sql", recorded["setup_sha256"])
            verify_file(safety, runner, recorded["runner_sha256"])

    python_files = list(ROOT.rglob("*.py"))
    for path in python_files:
        ast.parse(path.read_text(), filename=str(path))
    # Parse evidence without rewriting it or treating a saved pass as a new run.
    for path in ROOT.rglob("*.json"):
        json.loads(path.read_text())
    for path in ROOT.rglob("*.jsonl"):
        for line in path.read_text().splitlines():
            if line.strip():
                json.loads(line)
    print(f"Verified {len(entries)} vendor sources, {len(records)} licenses, "
          f"and syntax of {len(python_files)} Python files; no database proof executed.")


if __name__ == "__main__":
    main()
