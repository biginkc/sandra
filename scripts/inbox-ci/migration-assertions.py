#!/usr/bin/env python3
"""Pure checks for the disposable Inbox migration rehearsal."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

VERSIONS = ('20260929000000', '20260929000100', '20260929000200')
NAMES = ('inbox_control_foundation', 'inbox_read_companion', 'inbox_backend_operation_reply')
REFUSAL = 'Existing candidate: use validated forward upgrade, never reset'


def migration_files(root):
    directory = Path(root) / 'supabase/migrations'
    expected = [directory / f'{version}_{name}.sql' for version, name in zip(VERSIONS, NAMES)]
    actual = sorted(directory.glob('2026092900*.sql'))
    missing = [p.name for p in expected if not p.is_file()]
    if missing or actual != expected:
        raise ValueError(f'Checkout must contain exactly the three reviewed 2026092900* migrations; missing={missing}; found={[p.name for p in actual]}')
    return expected


def assert_full_history(root, installed_versions):
    expected = {p.name.split('_', 1)[0] for p in (Path(root) / 'supabase/migrations').glob('*.sql')
                if not p.name.startswith('2026092900')}
    if not expected or set(installed_versions) != expected or len(installed_versions) != len(expected):
        raise ValueError(f'Pre-migration history incomplete: expected={len(expected)} installed={len(installed_versions)}')


def index_statements(source):
    statements = [part.strip() for part in re.sub(r'(?m)^--.*$', '', source).split(';') if part.strip()]
    if len(statements) != 8 or any(not re.fullmatch(r'CREATE INDEX CONCURRENTLY IF NOT EXISTS [a-z_]+ ON public\.[^;]+', stmt, re.I | re.S) for stmt in statements):
        raise ValueError('Expected eight canonical CREATE INDEX CONCURRENTLY statements')
    return statements


def assert_second_apply(status, stderr, versions):
    if status != 3 or REFUSAL not in stderr:
        raise ValueError(f'Second foundation apply did not refuse with exit 3 and exact text (exit={status})')
    if sorted(versions) != list(VERSIONS):
        raise ValueError(f'Inbox migration ledger changed after refused second apply: {versions}')


def assert_verify(output):
    lines = [line for line in output.splitlines() if line.startswith('{')]
    if not lines or json.loads(lines[-1]).get('private_helper_exposure_count') != 0:
        raise ValueError('verify.py --installed did not prove private_helper_exposure_count: 0')


def assert_mutations(path):
    result = json.loads(Path(path).read_text())
    cases = result.get('cases', [])
    if result.get('passed') is not True or len(cases) != 41 or any(not c.get('drift_caught') or not c.get('restored_pass') for c in cases):
        raise ValueError('41-case mutation proof incomplete')


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[2]
    try:
        migration_files(root)
        command = sys.argv[1] if len(sys.argv) > 1 else 'preflight'
        if command == 'indexes':
            for statement in index_statements((root / 'experiments/inbox-production-install/operator/concurrent-indexes.sql').read_text()):
                subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', 'exec', '-i', os.environ['INBOX_SCRATCH_CONTAINER'], 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input=statement+';\n', text=True, check=True)
        elif command == 'second-apply':
            assert_second_apply(int(sys.argv[2]), Path(sys.argv[3]).read_text(), sys.argv[4:])
        elif command == 'verify':
            assert_verify(Path(sys.argv[2]).read_text())
        elif command == 'mutations':
            assert_mutations(sys.argv[2])
        elif command == 'history':
            assert_full_history(root, Path(sys.argv[2]).read_text().splitlines())
        elif command != 'preflight':
            raise ValueError('Unknown assertion command')
    except ValueError as exc:
        sys.exit(str(exc))
