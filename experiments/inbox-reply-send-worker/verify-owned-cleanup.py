#!/usr/bin/env python3
"""[Astra round-5] Mutation-first proof that owned_cleanup.py's residual
checker itself cannot be defeated by a synthetic content mutation in a
non-id, non-counter column of a shared counter/serialization table.

Astra's own independent check (a full before/after row hash) caught what
round-4's checker missed: replacing
public.hugo_owner_guard_serialization.guard_key='memberships' with a
synthetic value, and replacing the uuid in
inbox_t2_capture_boundary.generation.generation, BOTH leave row count and
the recognized counter column (version, and "no counter column" for
generation) unchanged — round-4's checker passed both silently.

This script reproduces both defeats, ROLLBACK-ONLY (a single held-open
transaction per mutation; nothing is ever committed), using owned_cleanup's
own _content_hash_sql — the exact function the real residual check calls —
and shows the hash differs (i.e. the round-5 checker WOULD now fail loudly)
for both, then shows an ordinary, unmutated re-check of the same tables
passes (hash unchanged) as a positive control.
"""
import json
import subprocess
import sys
from pathlib import Path
P = Path(__file__).resolve().parent
sys.path.insert(0, str(P.parent / 'inbox-projection' / 'fixture'))
from guards import validate_container, validate_cron
import owned_cleanup

if sys.argv[1:] != ['--run-owned-fixture']:
    raise SystemExit('Explicit owned fixture required')

D = ['docker', '--host', 'unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N = 'sandra-inbox-projection-t2-db'
CMD = D + ['exec', '-i', N, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']


def need(v, label):
    if not v:
        raise RuntimeError(label)


def sql(q, timeout=20, check=True):
    r = subprocess.run(CMD, input="SET statement_timeout='15s'; SET lock_timeout='10s'; BEGIN;" + q.rstrip() + ";COMMIT;", text=True, capture_output=True, timeout=timeout)
    if check and r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run_rollback_only(statements):
    """One psql invocation, one transaction: BEGIN; <statements>; ROLLBACK;
    Every mutation this script performs is undone by the same connection
    that made it, before that connection ever closes — nothing is ever
    committed."""
    script = "BEGIN;\n" + "\n".join(statements) + "\nROLLBACK;\n"
    r = subprocess.run(CMD, input=script, text=True, capture_output=True, timeout=20)
    need(r.returncode == 0, f'rollback-only session failed: {r.stderr}')
    return [line for line in r.stdout.splitlines() if line.strip()]


validate_container(json.loads(subprocess.check_output(D + ['inspect', N], text=True))[0])
validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity') == 'sandra-inbox-projection-t2-owned-synthetic', 'Wrong fixture')

checks = []

# === Defeat mutation 1: hugo_owner_guard_serialization.guard_key swap ===
# (round-4's checker: row count 1->1, version sum unchanged -> PASSED. This
# is exactly what round 4 shipped and Astra defeated.)
hugo_hash_sql = owned_cleanup._content_hash_sql('public.hugo_owner_guard_serialization', 'version')
out = run_rollback_only([
    f"SELECT count(*) AS before_count, coalesce(sum(version),0) AS before_version, ({hugo_hash_sql}) AS before_hash FROM public.hugo_owner_guard_serialization;",
    "UPDATE public.hugo_owner_guard_serialization SET guard_key='SYNTHETIC-DEFEAT-ASTRA-R5' WHERE guard_key='memberships';",
    f"SELECT count(*) AS after_count, coalesce(sum(version),0) AS after_version, ({hugo_hash_sql}) AS after_hash FROM public.hugo_owner_guard_serialization;",
])
before_count, before_version, before_hash = out[0].split('|')
after_count, after_version, after_hash = out[1].split('|')
need(before_count == after_count, 'defeat mutation 1 unexpectedly changed row count — not a faithful repro of the round-5 finding')
need(before_version == after_version, 'defeat mutation 1 unexpectedly changed the version sum — not a faithful repro of the round-5 finding')
need(before_hash != after_hash, 'ROUND-5 CHECKER STILL DEFEATED: guard_key swap left the content hash unchanged')
print(f'  CAUGHT  public.hugo_owner_guard_serialization: row count unchanged ({before_count}), version sum unchanged ({before_version}), but content hash CHANGED ({before_hash} -> {after_hash}) — the round-5 checker FAILS this by name; round-4\'s checker (count+counter-sum only) would have PASSED it silently')
checks.append('defeat mutation 1 (hugo_owner_guard_serialization.guard_key synthetic swap): content hash changed, row count and counter unchanged — now caught')

# === Defeat mutation 2: inbox_t2_capture_boundary.generation UUID swap ===
# (round-4's checker: no counter column recognized at all for this table, so
# only row count was ever compared — 1->1 -> PASSED.)
gen_hash_sql = owned_cleanup._content_hash_sql('inbox_t2_capture_boundary.generation', None)
out = run_rollback_only([
    f"SELECT count(*) AS before_count, ({gen_hash_sql}) AS before_hash FROM inbox_t2_capture_boundary.generation;",
    "UPDATE inbox_t2_capture_boundary.generation SET generation='11111111-1111-1111-1111-111111111111' WHERE singleton IS TRUE;",
    f"SELECT count(*) AS after_count, ({gen_hash_sql}) AS after_hash FROM inbox_t2_capture_boundary.generation;",
])
before_count, before_hash = out[0].split('|')
after_count, after_hash = out[1].split('|')
need(before_count == after_count, 'defeat mutation 2 unexpectedly changed row count — not a faithful repro of the round-5 finding')
need(before_hash != after_hash, 'ROUND-5 CHECKER STILL DEFEATED: generation uuid swap left the content hash unchanged')
print(f'  CAUGHT  inbox_t2_capture_boundary.generation: row count unchanged ({before_count}), but content hash CHANGED ({before_hash} -> {after_hash}) — the round-5 checker FAILS this by name; round-4\'s checker (row count only, no counter column recognized here) would have PASSED it silently')
checks.append('defeat mutation 2 (inbox_t2_capture_boundary.generation uuid synthetic swap): content hash changed, row count unchanged — now caught')

# === Positive control: two independent, UNMUTATED rollback-only re-checks
# of both tables produce the identical content hash — proves the check is
# not merely noisy/always-failing, only the actual mutations above trip it ===
check_a = run_rollback_only([f"SELECT ({hugo_hash_sql}) AS h1, ({gen_hash_sql}) AS h2;"])[0].split('|')
check_b = run_rollback_only([f"SELECT ({hugo_hash_sql}) AS h1, ({gen_hash_sql}) AS h2;"])[0].split('|')
need(check_a == check_b, 'positive control: unmutated re-check should be stable across independent rollback-only sessions')
print('  OK  positive control: two independent, unmutated rollback-only re-checks of both tables produce the IDENTICAL content hash — the check is not merely noisy/always-failing')
checks.append('positive control: unmutated content hash is stable across independent checks')

print(f'\nALL {len(checks)} ROUND-5 CHECKER-DEFEAT PROOFS PASSED (both mutations were ROLLBACK-ONLY; nothing committed)')
for c in checks:
    print('  -', c)
