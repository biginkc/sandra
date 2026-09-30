#!/usr/bin/env python3
"""Launch the Node LOCAL-DB fake-context driver without creating bytecode."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / "experiments/inbox-reply-send-worker/restate-retry-local-db.mjs"


def main() -> int:
    result = subprocess.run(
        ["node", str(DRIVER), *sys.argv[1:]],
        cwd=ROOT,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
