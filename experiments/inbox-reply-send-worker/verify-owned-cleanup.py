#!/usr/bin/env python3
"""[Astra round-5/6] Mutation-first proof that owned_cleanup.py's residual
checker itself cannot be defeated by a synthetic content mutation — neither
in a non-id, non-counter column of a shared counter/serialization table
(round 5), nor in a PRE-EXISTING (non-synthetic) baseline row of an
id-scoped table, alongside a net-zero create+delete of this run's own
synthetic row (round 6).

Round 5: Astra's own independent check (a full before/after row hash) caught
what round-4's checker missed: replacing
public.hugo_owner_guard_serialization.guard_key='memberships' with a
synthetic value, and replacing the uuid in
inbox_t2_capture_boundary.generation.generation, BOTH leave row count and
the recognized counter column (version, and "no counter column" for
generation) unchanged — round-4's checker passed both silently.

Round 6: the round-5 content hash was applied only to the "neither org_id
nor user_id" counter/shared set. Astra's repro: seed a BASELINE row in
inbox_t2_policy.versions (org_id NOT one of this run's own ids), create+
delete THIS RUN'S OWN owned row (net zero — org_id one of this run's ids),
then mutate the baseline row's entity_key. Row count (1 baseline row, before
and after) and the revision sum (unchanged) both look identical — round-5's
checker (which never even looked at id-scoped tables' baseline rows) passed
silently.

This script reproduces all three defeats, ROLLBACK-ONLY (a single held-open
transaction per mutation; nothing is ever committed), using owned_cleanup's
own _content_hash_sql/_not_owned_filter — the exact functions the real
residual check calls — and shows the hash differs (i.e. the checker WOULD
now fail loudly) for all three, then shows an ordinary, unmutated re-check
of the same tables passes (hash unchanged) as a positive control.
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

# === Defeat mutation 3 [Astra round-6]: inbox_t2_policy.versions —
# seed a BASELINE row (not this run's own id), create+delete THIS RUN'S OWN
# owned row net-zero, then mutate the baseline row's entity_key. ===
policy_col = owned_cleanup._counter_column(sql, 'inbox_t2_policy.versions')
need(policy_col == 'revision', f'inbox_t2_policy.versions counter-column detection drifted: {policy_col!r}')
baseline_org = '22222222-2222-2222-2222-222222222222'  # a "pre-existing baseline row", NOT one of this run's own ids
owned_org = '33333333-3333-3333-3333-333333333333'  # stands in for "this run's own synthetic org"
owned_orgs_array = owned_cleanup._text_array([owned_org])
not_owned_filter = owned_cleanup._not_owned_filter(True, False, owned_orgs_array, owned_cleanup._text_array([]))
policy_hash_sql = owned_cleanup._content_hash_sql('inbox_t2_policy.versions', policy_col, not_owned_filter)
out = run_rollback_only([
    f"INSERT INTO inbox_t2_policy.versions(org_id,namespace,entity_key,revision) VALUES('{baseline_org}','property_identity','astra-r6-baseline-entity',1);",
    f"SELECT count(*) AS before_count, coalesce(sum(revision),0) AS before_revision, ({policy_hash_sql}) AS before_hash FROM inbox_t2_policy.versions WHERE org_id::text='{baseline_org}';",  # sanity readback of the seeded row alone
    f"SELECT ({policy_hash_sql}) AS baseline_filter_hash_seed;",
    # This run's own owned row: create, then delete — net zero, exactly what sweep_delete does.
    f"INSERT INTO inbox_t2_policy.versions(org_id,namespace,entity_key,revision) VALUES('{owned_org}','property_identity','this-runs-own-entity',1);",
    f"DELETE FROM inbox_t2_policy.versions WHERE org_id::text='{owned_org}';",
    f"SELECT count(*) AS before_full_count, coalesce(sum(revision),0) AS before_full_revision, ({policy_hash_sql}) AS before_full_hash FROM inbox_t2_policy.versions;",
    # The round-6 defeat: mutate the BASELINE row's entity_key (not this run's own row).
    f"UPDATE inbox_t2_policy.versions SET entity_key='astra-r6-MUTATED-entity' WHERE org_id::text='{baseline_org}';",
    f"SELECT count(*) AS after_full_count, coalesce(sum(revision),0) AS after_full_revision, ({policy_hash_sql}) AS after_full_hash FROM inbox_t2_policy.versions;",
])
before_full_count, before_full_revision, before_full_hash = out[2].split('|')
after_full_count, after_full_revision, after_full_hash = out[3].split('|')
need(before_full_count == after_full_count, 'defeat mutation 3 unexpectedly changed row count — not a faithful repro of the round-6 finding (Astra\'s repro is explicitly row-count-neutral: create+delete this run\'s own row net zero)')
need(before_full_revision == after_full_revision, 'defeat mutation 3 unexpectedly changed the revision sum — not a faithful repro of the round-6 finding')
need(before_full_hash != after_full_hash, 'ROUND-6 CHECKER STILL DEFEATED: baseline-row entity_key swap (net-zero owned-row create+delete) left the not-owned content hash unchanged')
print(f'  CAUGHT  inbox_t2_policy.versions: row count unchanged ({before_full_count}), revision sum unchanged ({before_full_revision}), this run\'s OWN row created+deleted net-zero, but the BASELINE row\'s entity_key mutation changed the not-owned content hash ({before_full_hash} -> {after_full_hash}) — the round-6 checker FAILS this by name; the round-5 checker (which never hashed id-scoped tables\' baseline rows at all) would have PASSED it silently')
checks.append('defeat mutation 3 (inbox_t2_policy.versions baseline-row entity_key mutation, net-zero owned row): not-owned content hash changed, row count and counter unchanged — now caught')

# === Positive control: two independent, UNMUTATED rollback-only re-checks
# of all three tables produce the identical content hash — proves the check
# is not merely noisy/always-failing, only the actual mutations above trip it ===
control_query = f"SELECT ({hugo_hash_sql}) AS h1, ({gen_hash_sql}) AS h2, ({owned_cleanup._content_hash_sql('inbox_t2_policy.versions', policy_col)}) AS h3;"
check_a = run_rollback_only([control_query])[0].split('|')
check_b = run_rollback_only([control_query])[0].split('|')
need(check_a == check_b, 'positive control: unmutated re-check should be stable across independent rollback-only sessions')
print('  OK  positive control: two independent, unmutated rollback-only re-checks of all three tables produce the IDENTICAL content hash — the check is not merely noisy/always-failing')
checks.append('positive control: unmutated content hash is stable across independent checks (all three tables)')

print(f'\nALL {len(checks)} CHECKER-DEFEAT PROOFS PASSED (rounds 5+6; every mutation was ROLLBACK-ONLY; nothing committed)')
for c in checks:
    print('  -', c)
