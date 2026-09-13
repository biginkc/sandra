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
