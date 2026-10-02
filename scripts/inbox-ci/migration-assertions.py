#!/usr/bin/env python3
"""Pure checks for the disposable Inbox migration rehearsal."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

MANIFEST_PATH = Path(__file__).with_name('inbox-migrations.json')
MANIFEST = json.loads(MANIFEST_PATH.read_text())
VERSIONS = tuple(entry['version'] for entry in MANIFEST)
NAMES = tuple(entry['name'] for entry in MANIFEST)
RESERVED_START = min(VERSIONS)
RESERVED_END = '20261002100260'
REFUSAL = 'Existing candidate: use validated forward upgrade, never reset'


def docker_socket(env):
    if env.get('MIGRATION_LOCAL_EXECUTION') == '1':
        socket = env.get('DOCKER_HOST', '')
        if not socket.startswith('unix:///') or socket == 'unix:///var/run/docker.sock':
            raise ValueError('Local diagnostic requires a Colima Unix DOCKER_HOST')
        return socket
    if env.get('DOCKER_HOST', 'unix:///var/run/docker.sock') != 'unix:///var/run/docker.sock':
        raise ValueError('Runner requires /var/run/docker.sock')
    return 'unix:///var/run/docker.sock'


def migration_files(root):
    directory = Path(root) / 'supabase/migrations'
    if not directory.is_dir():
        raise ValueError('Checkout must contain exactly the manifest Inbox migrations; missing=migrations directory')
    expected = [directory / f'{version}_{name}.sql' for version, name in zip(VERSIONS, NAMES)]
    def inbox_candidate(path):
        return re.fullmatch(r'\d{14}_inbox_[a-z0-9_]+\.sql', path.name) is not None
    actual = sorted(p for p in directory.iterdir() if p.is_file() and inbox_candidate(p))
    missing = [p.name for p in expected if not p.is_file()]
    if missing or actual != expected:
        raise ValueError(f'Checkout must contain exactly the manifest Inbox migrations; missing={missing}; found={[p.name for p in actual]}')
    return expected


def assert_full_history(root, installed_versions):
    manifest_files = {f'{version}_{name}.sql' for version, name in zip(VERSIONS, NAMES)}
    expected = {p.name.split('_', 1)[0] for p in (Path(root) / 'supabase/migrations').glob('*.sql')
                if p.name not in manifest_files}
    if not expected or set(installed_versions) != expected or len(installed_versions) != len(expected):
        raise ValueError(f'Pre-migration history incomplete: expected={len(expected)} installed={len(installed_versions)}')


def index_statements(source):
    statements = [part.strip() for part in re.sub(r'(?m)^--.*$', '', source).split(';') if part.strip()]
    if len(statements) != 8 or any(not re.fullmatch(r'CREATE INDEX CONCURRENTLY IF NOT EXISTS [a-z_]+ ON public\.[^;]+', stmt, re.I | re.S) for stmt in statements):
        raise ValueError('Expected eight canonical CREATE INDEX CONCURRENTLY statements')
    return statements


def assert_index_preconditions(output):
    rows = [line.strip().split('|') for line in output.splitlines() if line.strip()]
    if len(rows) != 8 or any(len(row) != 4 or row[1:] != ['t', '8', 't'] for row in rows):
        raise ValueError('Eight valid concurrent indexes not proven')


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


def assert_catalog_live(output):
    if not re.search(r'Ran 5 tests? in ', output) or output.rstrip().splitlines()[-1] != 'OK':
        raise ValueError('Five live catalog mutation tests did not run without skips')


def assert_offline_suite(output):
    match = re.search(r'(?m)^Ran (\d+) tests? in ', output)
    if not match or int(match.group(1)) < 64 or output.rstrip().splitlines()[-1] != 'OK':
        raise ValueError('Reviewed production-install unit suite incomplete or skipped')


def assert_catalog_unchanged(first, second):
    before = json.loads(Path(first).read_text()).get('section_sha256')
    after = json.loads(Path(second).read_text()).get('section_sha256')
    if not before or before != after:
        raise ValueError('Catalog changed after mutation harness')


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[2]
    try:
        migration_files(root)
        command = sys.argv[1] if len(sys.argv) > 1 else 'preflight'
        if command == 'indexes':
            for statement in index_statements((root / 'experiments/inbox-production-install/operator/concurrent-indexes.sql').read_text()):
                subprocess.run(['docker', '--host', docker_socket(os.environ), 'exec', '-i', os.environ['INBOX_SCRATCH_CONTAINER'], 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input=statement+';\n', text=True, check=True)
        elif command == 'second-apply':
            assert_second_apply(int(sys.argv[2]), Path(sys.argv[3]).read_text(), sys.argv[4:])
        elif command == 'verify':
            assert_verify(Path(sys.argv[2]).read_text())
        elif command == 'index-preconditions':
            assert_index_preconditions(Path(sys.argv[2]).read_text())
        elif command == 'mutations':
            assert_mutations(sys.argv[2])
        elif command == 'catalog-live':
            assert_catalog_live(Path(sys.argv[2]).read_text())
        elif command == 'offline-suite':
            assert_offline_suite(Path(sys.argv[2]).read_text())
        elif command == 'catalog-unchanged':
            assert_catalog_unchanged(sys.argv[2], sys.argv[3])
        elif command == 'history':
            assert_full_history(root, Path(sys.argv[2]).read_text().splitlines())
        elif command != 'preflight':
            raise ValueError('Unknown assertion command')
    except ValueError as exc:
        sys.exit(str(exc))
