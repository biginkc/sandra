#!/usr/bin/env python3
"""Run the migration-owned catalog fingerprint with a repeatable-read assertion.

The migration branch supplies catalog_fingerprint.py and its scope manifest after
rebase. No copy of either file lives in this workstream.
"""
import importlib.util
from pathlib import Path
import subprocess
import sys

SOURCE = Path(__file__).resolve().parents[2] / 'experiments/inbox-production-install/catalog_fingerprint.py'
if not SOURCE.is_file():
    raise SystemExit('CATALOG_TOOL_UNAVAILABLE: rebase migrations branch')
spec = importlib.util.spec_from_file_location('catalog_fingerprint', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = subprocess.run


def guarded_run(*args, **kwargs):
    sql = kwargs.get('input', '')
    marker = 'BEGIN READ ONLY;\nSHOW transaction_read_only;'
    if marker not in sql:
        raise RuntimeError('Catalog transaction opening changed; review adapter')
    kwargs['input'] = sql.replace(marker, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSHOW transaction_isolation;\nSHOW transaction_read_only;', 1)
    result = original(*args, **kwargs)
    lines = result.stdout.splitlines()
    if len(lines) < 4 or lines[0] != 'BEGIN' or lines[1] != 'repeatable read' or lines[2] != 'on':
        raise RuntimeError('READ_PRECONDITION_FAILED: catalog isolation/read-only assertion')
    result.stdout = '\n'.join([lines[0]] + lines[2:]) + '\n'
    return result


module.subprocess.run = guarded_run
sys.argv = [str(SOURCE)]
module.main()
