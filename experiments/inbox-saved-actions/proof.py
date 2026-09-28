#!/usr/bin/env python3
"""Mutation-first proof for the personal saved-action definitions backend
(setup.sql/public-api.sql): immutable versions, requester+org scoping,
reference validation at SAVE and again at EXECUTE (get()), disabled
gated-step-type rejection (promote/dismiss_unknown/restore_unknown/dnc),
stale-version rejection after edit/deactivate, and public-wrapper
least-privilege. Owned fixture only.

Installs the schema only into a fresh fixture. An already-present schema is a
hard refusal: reusing it could prove a different revision than the checked-
out source under review.
The entire proof scenario runs inside ONE explicit transaction that always
ROLLBACKs (never commits fixture rows), so no cleanup sweep is needed for
correctness — owned_cleanup's discover/snapshot_baseline/assert_clean are
still run around it as an independent, whole-DB content-signature check
that the rollback really left zero residual (per the brief: reuse
owned_cleanup.py for the proof residual check)."""
import json, subprocess, sys
from pathlib import Path
P = Path(__file__).resolve().parent
sys.path.insert(0, str(P.parent / 'inbox-projection' / 'fixture'))
from guards import validate_container, validate_cron
import owned_cleanup
if sys.argv[1:] != ['--run-owned-fixture']:
    raise SystemExit('Explicit owned fixture required')
D = ['docker', '--host', 'unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N = 'sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D + ['inspect', N], text=True))[0])


def sql(q, timeout=30):
    r = subprocess.run(D + ['exec', '-i', N, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
                        input=q, text=True, capture_output=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def sql_with_notices(q, timeout=30):
    # RAISE NOTICE output (the proof scenario's PASS/FAIL trail) is written to
    # stderr by psql, never stdout; both are needed to read the pass log.
    r = subprocess.run(D + ['exec', '-i', N, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
                        input=q, text=True, capture_output=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip() + '\n' + r.stderr.strip()


validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql("SELECT marker FROM inbox_t2_fixture.identity") != 'sandra-inbox-projection-t2-owned-synthetic':
    raise RuntimeError('Wrong fixture')

if sql("SELECT to_regnamespace('inbox_saved_actions') IS NULL") == 't':
    setup = (P / 'setup.sql').read_text()
    public_api = (P / 'public-api.sql').read_text()
    for src in (setup, public_api):
        if not src.endswith('COMMIT;\n') or '\nBEGIN;\n' not in src:
            raise RuntimeError('Expected source transaction boundary')
    r = subprocess.run(D + ['exec', '-i', N, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
                        input=setup + public_api, text=True, capture_output=True, timeout=30)
    if r.returncode:
        raise RuntimeError(f'install failed: {r.stderr}')
    print('INSTALLED inbox_saved_actions schema')
else:
    raise RuntimeError('inbox_saved_actions already installed; refusing to reuse stale schema — run against a fresh owned fixture')

# Astra round-1 blocker #1: (re-)apply the widened inbox_action_api.prepare
# envelope guard every run. Idempotent (CREATE OR REPLACE of the exact
# unmodified upstream body, only the savedAction guard widened), and cheap
# to reapply even when inbox_saved_actions itself was already installed.
prepare_patch = (P / 'action-prepare-saved-reference.sql').read_text()
if not prepare_patch.endswith('COMMIT;\n') or '\nBEGIN;\n' not in prepare_patch:
    raise RuntimeError('Expected source transaction boundary')
r = subprocess.run(D + ['exec', '-i', N, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
                    input=prepare_patch, text=True, capture_output=True, timeout=30)
if r.returncode:
    raise RuntimeError(f'action-prepare-saved-reference.sql install failed: {r.stderr}')
print('APPLIED inbox_action_api.prepare savedAction-reference widening')

ORG_TABLES, USER_TABLES, ALL_TABLES = owned_cleanup.discover(sql)
BASELINE = owned_cleanup.snapshot_baseline(sql, ALL_TABLES)

TEST = (P / 'proof-scenario.sql').read_text()
REQUIRED_MARKERS = ('ALL SAVED-ACTION SQL PROOFS PASSED', 'ALL SAVED-ACTION END-TO-END PREPARE PROOFS PASSED')
if not TEST.strip().startswith('DO $test$') or any(marker not in TEST for marker in REQUIRED_MARKERS):
    raise RuntimeError('Unexpected proof scenario source')
output = sql_with_notices('BEGIN;' + TEST + 'ROLLBACK;')
for marker in REQUIRED_MARKERS:
    if marker not in output:
        raise RuntimeError(f'Proof scenario did not report success ({marker}): {output}')
PASS_LINES = [line for line in output.splitlines() if 'PASS ' in line]
if len(PASS_LINES) < 17:
    raise RuntimeError(f'Expected at least 17 PASS lines, got {len(PASS_LINES)}: {output}')
for line in PASS_LINES:
    print(line)

advanced = owned_cleanup.assert_clean(sql, ALL_TABLES, BASELINE, set(), set())
print(f'RESIDUAL CHECK CLEAN (advanced counters: {advanced})')
print('SAVED-ACTIONS PROOF: ALL GREEN')
