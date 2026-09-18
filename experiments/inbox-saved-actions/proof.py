#!/usr/bin/env python3
"""Mutation-first proof for the personal saved-action definitions backend
(setup.sql/public-api.sql): immutable versions, requester+org scoping,
reference validation at SAVE and again at EXECUTE (get()), disabled
gated-step-type rejection (promote/dismiss_unknown/restore_unknown/dnc),
stale-version rejection after edit/deactivate, and public-wrapper
least-privilege. Owned fixture only.

Installs the schema once (idempotent: skipped if already present, mirroring
the "refuse existing schema" guard other experiments use, but here as a
skip rather than a hard refusal since this schema is itself this PR's
deliverable and is expected to already be installed across repeated runs).
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
    print('inbox_saved_actions already installed; reusing')

# Re-apply the authoritative inbox_action_api.prepare saved-reference guard
# and stored-snapshot binding every run. This is idempotent and cheap even
# when inbox_saved_actions itself was already installed; the SQL proof below
# independently exercises the public boundary rather than trusting the TS
# lookup path.
prepare_patch = (P / 'action-prepare-saved-reference.sql').read_text()
if not prepare_patch.endswith('COMMIT;\n') or '\nBEGIN;\n' not in prepare_patch:
    raise RuntimeError('Expected source transaction boundary')
r = subprocess.run(D + ['exec', '-i', N, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
                    input=prepare_patch, text=True, capture_output=True, timeout=30)
if r.returncode:
    raise RuntimeError(f'action-prepare-saved-reference.sql install failed: {r.stderr}')
print('APPLIED inbox_action_api.prepare savedAction shape guard + snapshot binding')

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
