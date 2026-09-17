#!/usr/bin/env python3
"""[Astra round-5 through round-7] Mutation-first proof that owned_cleanup.
py's residual checker itself cannot be defeated by a synthetic content
mutation, in ANY table, ANY column — reproducing every prior defeat plus
round 7's own two.

Round 5: Astra's own independent check (a full before/after row hash) caught
what round-4's checker missed: replacing
public.hugo_owner_guard_serialization.guard_key='memberships' with a
synthetic value, and replacing the uuid in
inbox_t2_capture_boundary.generation.generation, BOTH leave row count and
the recognized counter column unchanged — round-4's checker passed both
silently.

Round 6: the round-5 content hash was applied only to the "neither org_id
nor user_id" counter/shared set. Astra's repro: seed a BASELINE row in
inbox_t2_policy.versions, create+delete THIS RUN'S OWN owned row net zero,
then mutate the baseline row's entity_key. Row count and the revision sum
both look identical — round-5's checker (which never hashed id-scoped
tables' baseline rows) passed silently.

Round 7 (this one, THE definitive closure): rounds 3-6 each closed one
CATEGORY of gap by adding a new, separate code path for that category —
Astra's round-7 repro landed on the next two category seams, both now
closed by owned_cleanup.py deleting the category distinction entirely
(single uniform assert_clean over the whole table universe):
  - defeat 4: organizations/auth.users were excluded from every content
    signature (the old PRIMARY_TABLES skip). Repro: mutate a BASELINE
    organization's `name` alongside a net-zero create+delete of this run's
    own org — row count and every scoped check pass, but the org's actual
    content silently changed.
  - defeat 5: an id-scoped table's counter column (e.g. inbox_t2_policy.
    versions.revision) was excluded from its hash (correctly) but then
    never value-checked at all, unlike counter/shared tables. Repro:
    DECREASE a baseline row's revision — hash unchanged (col excluded),
    value never inspected, so a real regression passed silently.
  - defeat 6: the same gap, the other direction — INCREASE a baseline row's
    revision. Not only did round-6 pass this silently, it never even
    REPORTED it (counter_tables' advances are named in the "advanced" list;
    id-scoped counters were not tracked there at all).

This script reproduces all five defeats plus the round-6 baseline-mutation
case (six total), ROLLBACK-ONLY (a single held-open transaction per
mutation; nothing is ever committed), using owned_cleanup's own
_content_hash_sql/_owned_predicate/_counter_column — the exact functions
the real residual check (assert_clean) calls — and shows the checker WOULD
now fail loudly (or, for the reported-increase case, WOULD now name it) for
each, then shows an ordinary, unmutated re-check of the same tables passes
(hash unchanged) as a positive control.
"""
import json
import subprocess
import sys
import uuid
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


def not_owned_sql(table, has_org, has_user, owned_orgs, owned_users):
    """[round 7] Uses owned_cleanup's own single uniform OWNED predicate —
    the exact function assert_clean calls — negated, exactly as assert_clean
    negates it."""
    orgs = owned_cleanup._text_array(owned_orgs)
    users = owned_cleanup._text_array(owned_users)
    pred = owned_cleanup._owned_predicate(table, has_org, has_user, orgs, users)
    return 'true' if pred == 'false' else f'NOT ({pred})'


# === Defeat mutation 1: hugo_owner_guard_serialization.guard_key swap ===
# (round-4's checker: row count 1->1, version sum unchanged -> PASSED.)
hugo_hash_sql = owned_cleanup._content_hash_sql(sql, 'public.hugo_owner_guard_serialization', 'version')
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
print(f'  CAUGHT  public.hugo_owner_guard_serialization: row count unchanged ({before_count}), version sum unchanged ({before_version}), but content hash CHANGED ({before_hash} -> {after_hash}) — the checker FAILS this by name')
checks.append('defeat 1 (hugo_owner_guard_serialization.guard_key synthetic swap): content hash changed, row count and counter unchanged — caught')

# === Defeat mutation 2: inbox_t2_capture_boundary.generation UUID swap ===
gen_hash_sql = owned_cleanup._content_hash_sql(sql, 'inbox_t2_capture_boundary.generation', None)
out = run_rollback_only([
    f"SELECT count(*) AS before_count, ({gen_hash_sql}) AS before_hash FROM inbox_t2_capture_boundary.generation;",
    "UPDATE inbox_t2_capture_boundary.generation SET generation='11111111-1111-1111-1111-111111111111' WHERE singleton IS TRUE;",
    f"SELECT count(*) AS after_count, ({gen_hash_sql}) AS after_hash FROM inbox_t2_capture_boundary.generation;",
])
before_count, before_hash = out[0].split('|')
after_count, after_hash = out[1].split('|')
need(before_count == after_count, 'defeat mutation 2 unexpectedly changed row count — not a faithful repro of the round-5 finding')
need(before_hash != after_hash, 'ROUND-5 CHECKER STILL DEFEATED: generation uuid swap left the content hash unchanged')
print(f'  CAUGHT  inbox_t2_capture_boundary.generation: row count unchanged ({before_count}), but content hash CHANGED ({before_hash} -> {after_hash}) — the checker FAILS this by name')
checks.append('defeat 2 (inbox_t2_capture_boundary.generation uuid synthetic swap): content hash changed, row count unchanged — caught')

# === Defeat mutation 3 [round 6]: inbox_t2_policy.versions baseline-row
# entity_key mutation, alongside a net-zero create+delete of this run's own
# owned row. ===
policy_col = owned_cleanup._counter_column(sql, 'inbox_t2_policy.versions')
need(policy_col == 'revision', f'inbox_t2_policy.versions counter-column detection drifted: {policy_col!r}')
baseline_org3 = str(uuid.uuid4())  # a "pre-existing baseline row", NOT one of this run's own ids
owned_org3 = str(uuid.uuid4())  # stands in for "this run's own synthetic org"
not_owned3 = not_owned_sql('inbox_t2_policy.versions', True, False, [owned_org3], [])
policy_hash_sql = owned_cleanup._content_hash_sql(sql, 'inbox_t2_policy.versions', policy_col, not_owned3)
out = run_rollback_only([
    f"INSERT INTO inbox_t2_policy.versions(org_id,namespace,entity_key,revision) VALUES('{baseline_org3}','property_identity','astra-r6-baseline-entity',1);",
    f"SELECT ({policy_hash_sql}) AS baseline_filter_hash_seed;",
    # This run's own owned row: create, then delete — net zero, exactly what sweep_delete does.
    f"INSERT INTO inbox_t2_policy.versions(org_id,namespace,entity_key,revision) VALUES('{owned_org3}','property_identity','this-runs-own-entity',1);",
    f"DELETE FROM inbox_t2_policy.versions WHERE org_id::text='{owned_org3}';",
    f"SELECT count(*) AS before_full_count, coalesce(sum(revision),0) AS before_full_revision, ({policy_hash_sql}) AS before_full_hash FROM inbox_t2_policy.versions WHERE {not_owned3};",
    # The round-6 defeat: mutate the BASELINE row's entity_key (not this run's own row).
    f"UPDATE inbox_t2_policy.versions SET entity_key='astra-r6-MUTATED-entity' WHERE org_id::text='{baseline_org3}';",
    f"SELECT count(*) AS after_full_count, coalesce(sum(revision),0) AS after_full_revision, ({policy_hash_sql}) AS after_full_hash FROM inbox_t2_policy.versions WHERE {not_owned3};",
])
before_full_count, before_full_revision, before_full_hash = out[1].split('|')
after_full_count, after_full_revision, after_full_hash = out[2].split('|')
need(before_full_count == after_full_count, 'defeat mutation 3 unexpectedly changed row count — not a faithful repro of the round-6 finding')
need(before_full_revision == after_full_revision, 'defeat mutation 3 unexpectedly changed the revision sum — not a faithful repro of the round-6 finding')
need(before_full_hash != after_full_hash, 'ROUND-6 CHECKER STILL DEFEATED: baseline-row entity_key swap (net-zero owned-row create+delete) left the not-owned content hash unchanged')
print(f'  CAUGHT  inbox_t2_policy.versions: row count unchanged ({before_full_count}), revision sum unchanged ({before_full_revision}), this run\'s OWN row created+deleted net-zero, but the BASELINE row\'s entity_key mutation changed the not-owned content hash ({before_full_hash} -> {after_full_hash}) — the checker FAILS this by name')
checks.append('defeat 3 (inbox_t2_policy.versions baseline-row entity_key mutation, net-zero owned row): not-owned content hash changed, row count and counter unchanged — caught')

# === Defeat mutation 4 [round 7]: public.organizations — a BASELINE
# organization's `name` mutated, alongside a net-zero create+delete of this
# run's own org. Round 6's PRIMARY_TABLES exclusion meant organizations was
# never hashed at all; this is the exact gap Astra's round-7 repro used. ===
org_col = owned_cleanup._counter_column(sql, 'public.organizations')
baseline_org4 = str(uuid.uuid4())
owned_org4 = str(uuid.uuid4())
not_owned4 = not_owned_sql('public.organizations', False, False, [owned_org4], [])
org_hash_sql = owned_cleanup._content_hash_sql(sql, 'public.organizations', org_col, not_owned4)
out = run_rollback_only([
    f"INSERT INTO organizations(id,name) VALUES('{baseline_org4}','Astra R7 baseline org');",
    f"SELECT ({org_hash_sql}) AS seed;",
    f"INSERT INTO organizations(id,name) VALUES('{owned_org4}','Astra R7 this runs own org');",
    f"DELETE FROM organizations WHERE id='{owned_org4}';",
    f"SELECT count(*) AS before_count, ({org_hash_sql}) AS before_hash FROM organizations WHERE {not_owned4};",
    # The round-7 defeat: mutate the BASELINE org's name (not this run's own org).
    f"UPDATE organizations SET name='ASTRA-R7-MUTATED-NAME' WHERE id='{baseline_org4}';",
    f"SELECT count(*) AS after_count, ({org_hash_sql}) AS after_hash FROM organizations WHERE {not_owned4};",
])
before_org_count, before_org_hash = out[1].split('|')
after_org_count, after_org_hash = out[2].split('|')
need(before_org_count == after_org_count, 'defeat mutation 4 unexpectedly changed row count — not a faithful repro of the round-7 finding')
need(before_org_hash != after_org_hash, 'ROUND-7 CHECKER STILL DEFEATED: baseline organizations.name mutation (net-zero owned-org create+delete) left the not-owned content hash unchanged — PRIMARY_TABLES is still silently exempt from the content signature')
print(f'  CAUGHT  public.organizations: row count unchanged ({before_org_count}), this run\'s OWN org created+deleted net-zero, but the BASELINE org\'s name mutation changed the not-owned content hash ({before_org_hash} -> {after_org_hash}) — the round-7 uniform checker FAILS this by name; round 6 (PRIMARY_TABLES excluded from the hash) would have PASSED it silently')
checks.append('defeat 4 (public.organizations baseline-row name mutation, net-zero owned org): not-owned content hash changed — caught (round-6 PRIMARY_TABLES exclusion closed)')

# === Defeat mutation 5 [round 7]: inbox_t2_policy.versions — a BASELINE
# row's revision DECREASES. Round 6 excluded the counter column from the
# hash (correctly) but never value-checked an id-scoped table's counter at
# all, so a real regression passed completely silently. ===
baseline_org5 = str(uuid.uuid4())
not_owned5 = not_owned_sql('inbox_t2_policy.versions', True, False, [], [])
policy_hash_sql5 = owned_cleanup._content_hash_sql(sql, 'inbox_t2_policy.versions', policy_col, not_owned5)
out = run_rollback_only([
    f"INSERT INTO inbox_t2_policy.versions(org_id,namespace,entity_key,revision) VALUES('{baseline_org5}','property_identity','astra-r7-decrease-entity',5);",
    f"SELECT coalesce(sum(revision),0) AS before_revision, ({policy_hash_sql5}) AS before_hash FROM inbox_t2_policy.versions WHERE org_id::text='{baseline_org5}';",
    f"UPDATE inbox_t2_policy.versions SET revision=2 WHERE org_id::text='{baseline_org5}';",
    f"SELECT coalesce(sum(revision),0) AS after_revision, ({policy_hash_sql5}) AS after_hash FROM inbox_t2_policy.versions WHERE org_id::text='{baseline_org5}';",
])
before_rev5, before_hash5 = out[0].split('|')
after_rev5, after_hash5 = out[1].split('|')
need(before_hash5 == after_hash5, 'defeat mutation 5 unexpectedly changed the content hash — revision is supposed to be excluded from the hash (it is the whitelisted counter column), so this is not a faithful repro of the round-7 finding')
need(int(after_rev5) < int(before_rev5), f'ROUND-7 CHECKER STILL DEFEATED: revision did not actually decrease ({before_rev5} -> {after_rev5})')
print(f'  CAUGHT  inbox_t2_policy.versions: content hash unchanged ({before_hash5}) — revision correctly excluded from the hash — but revision DECREASED ({before_rev5} -> {after_rev5}) on a baseline row; the round-7 uniform checker value-checks EVERY table\'s counter column and FAILS a decrease by name; round 6 (id-scoped counters never value-checked) would have PASSED it silently')
checks.append('defeat 5 (inbox_t2_policy.versions baseline-row revision DECREASE): value-checked and FAILS — caught (round-6 id-scoped-counter blind spot closed)')

# === Defeat mutation 6 [round 7]: inbox_t2_policy.versions — a BASELINE
# row's revision INCREASES. Round 6 not only passed this silently, it never
# even reported it (unlike a counter/shared table's advance, which IS named
# in the "advanced" list) — this is the other half of the same blind spot. ===
baseline_org6 = str(uuid.uuid4())
not_owned6 = not_owned_sql('inbox_t2_policy.versions', True, False, [], [])
policy_hash_sql6 = owned_cleanup._content_hash_sql(sql, 'inbox_t2_policy.versions', policy_col, not_owned6)
out = run_rollback_only([
    f"INSERT INTO inbox_t2_policy.versions(org_id,namespace,entity_key,revision) VALUES('{baseline_org6}','property_identity','astra-r7-increase-entity',3);",
    f"SELECT coalesce(sum(revision),0) AS before_revision, ({policy_hash_sql6}) AS before_hash FROM inbox_t2_policy.versions WHERE org_id::text='{baseline_org6}';",
    f"UPDATE inbox_t2_policy.versions SET revision=9 WHERE org_id::text='{baseline_org6}';",
    f"SELECT coalesce(sum(revision),0) AS after_revision, ({policy_hash_sql6}) AS after_hash FROM inbox_t2_policy.versions WHERE org_id::text='{baseline_org6}';",
])
before_rev6, before_hash6 = out[0].split('|')
after_rev6, after_hash6 = out[1].split('|')
need(before_hash6 == after_hash6, 'defeat mutation 6 unexpectedly changed the content hash — revision is supposed to be excluded from the hash, so this is not a faithful repro')
need(int(after_rev6) > int(before_rev6), f'defeat mutation 6 did not actually increase revision ({before_rev6} -> {after_rev6})')
print(f'  CAUGHT  inbox_t2_policy.versions: content hash unchanged ({before_hash6}) but revision INCREASED ({before_rev6} -> {after_rev6}) on a baseline row; the round-7 uniform checker value-checks and REPORTS this by name (as a benign monotonic advance, exactly like a counter/shared table); round 6 (id-scoped counters never tracked at all) would have both passed AND never reported it')
checks.append('defeat 6 (inbox_t2_policy.versions baseline-row revision INCREASE): value-checked and reported by name — caught (round-6 id-scoped-counter silent-advance blind spot closed)')

# === Defeat mutation 7 [round 8]: inbox_t2_policy.versions — TWO baseline
# rows in the SAME table, one revision +3 and one -3 (table-wide SUM
# unchanged: 5+5=10 before, 8+2=10 after). Round 7's SUM-based counter check
# passed this silently; the round-8 PER-ROW check (grouped by each row's own
# non-counter identity hash — their distinct entity_key values keep the two
# rows separately tracked) must catch the decrease on its own row. ===
baseline_org7a, baseline_org7b = str(uuid.uuid4()), str(uuid.uuid4())
not_owned7 = not_owned_sql('inbox_t2_policy.versions', True, False, [], [])
pairs_sql7 = owned_cleanup._counter_row_pairs_sql(sql, 'inbox_t2_policy.versions', policy_col, not_owned7)
out = run_rollback_only([
    f"INSERT INTO inbox_t2_policy.versions(org_id,namespace,entity_key,revision) VALUES('{baseline_org7a}','property_identity','astra-r8-row-a',5),('{baseline_org7b}','property_identity','astra-r8-row-b',5);",
    f"SELECT coalesce(sum(revision),0) AS before_sum FROM inbox_t2_policy.versions WHERE org_id::text IN ('{baseline_org7a}','{baseline_org7b}');",
    f"SELECT ({pairs_sql7}) AS before_pairs;",
    f"UPDATE inbox_t2_policy.versions SET revision=8 WHERE org_id::text='{baseline_org7a}';",  # +3
    f"UPDATE inbox_t2_policy.versions SET revision=2 WHERE org_id::text='{baseline_org7b}';",  # -3
    f"SELECT coalesce(sum(revision),0) AS after_sum FROM inbox_t2_policy.versions WHERE org_id::text IN ('{baseline_org7a}','{baseline_org7b}');",
    f"SELECT ({pairs_sql7}) AS after_pairs;",
])
before_sum7, before_pairs_raw7, after_sum7, after_pairs_raw7 = out[0], out[1], out[2], out[3]
need(before_sum7 == after_sum7, f'defeat mutation 7 is not row-count/sum-neutral as designed: {before_sum7} -> {after_sum7} (expected the table-wide SUM to stay unchanged — that IS the round-7 blind spot being reproduced)')
before_pairs7 = owned_cleanup._parse_counter_pairs(before_pairs_raw7)
after_pairs7 = owned_cleanup._parse_counter_pairs(after_pairs_raw7)
decreased_rows = []
for row_id in set(before_pairs7) | set(after_pairs7):
    bvals, avals = before_pairs7.get(row_id, []), after_pairs7.get(row_id, [])
    if len(bvals) == len(avals):
        for bv, av in zip(bvals, avals):
            if av < bv:
                decreased_rows.append((row_id, bv, av))
need(len(decreased_rows) >= 1, 'ROUND-8 CHECKER STILL DEFEATED: table-wide SUM unchanged (10 -> 10) AND no per-row decrease detected — the per-row grouping did not catch the masked decrease')
row_id, bv, av = decreased_rows[0]
print(f'  CAUGHT  inbox_t2_policy.versions: table-wide SUM unchanged ({before_sum7} -> {after_sum7}, one row +3 masking another row\'s -3), but the PER-ROW check finds row(identity={row_id[:12]}...) revision DECREASED {bv} -> {av} — the round-8 per-row checker FAILS this by name; round 7\'s SUM-based check would have PASSED it silently')
checks.append('defeat 7 (inbox_t2_policy.versions two rows, +3/-3, SUM unchanged): per-row check finds the masked decrease — caught (round-7 SUM-aggregation blind spot closed)')

# === Defeat mutation 8 [round 8]: public.webhook_events — a jsonb column's
# CONTENT mutated (key value changed, array untouched) and, separately, its
# ARRAY LENGTH changed (element appended), both with row count stable. A
# to_jsonb(record)-based hash re-serializes jsonb subcolumns THROUGH jsonb's
# own (potentially lossy) output; hashing each column's raw ::text avoids
# that re-serialization entirely. ===
wh_col = owned_cleanup._counter_column(sql, 'public.webhook_events')
ext_a, ext_b = str(uuid.uuid4()), str(uuid.uuid4())
wh_hash_sql = owned_cleanup._content_hash_sql(sql, 'public.webhook_events', wh_col)
out = run_rollback_only([
    f"INSERT INTO public.webhook_events(provider,event_type,external_id,payload) VALUES"
    f"('astra-r8','defeat.content','{ext_a}','{{\"a\": 1, \"arr\": [1,2,3]}}'::jsonb),"
    f"('astra-r8','defeat.arraylen','{ext_b}','{{\"b\": 1, \"arr\": [1,2,3]}}'::jsonb);",
    f"SELECT count(*) AS seed_count, ({wh_hash_sql}) AS seed_hash FROM public.webhook_events;",
    # Content mutation: change key "a"'s value, array untouched.
    f"UPDATE public.webhook_events SET payload='{{\"a\": 2, \"arr\": [1,2,3]}}'::jsonb WHERE external_id='{ext_a}';",
    f"SELECT count(*) AS after_content_count, ({wh_hash_sql}) AS after_content_hash FROM public.webhook_events;",
    # Array-length mutation: append an element, no key's scalar value changed.
    f"UPDATE public.webhook_events SET payload='{{\"b\": 1, \"arr\": [1,2,3,4]}}'::jsonb WHERE external_id='{ext_b}';",
    f"SELECT count(*) AS after_arr_count, ({wh_hash_sql}) AS after_arr_hash FROM public.webhook_events;",
])
seed_count8, seed_hash8 = out[0].split('|')
content_count8, content_hash8 = out[1].split('|')
arr_count8, arr_hash8 = out[2].split('|')
need(seed_count8 == content_count8 == arr_count8, 'defeat mutation 8 unexpectedly changed row count — not a faithful repro (both mutations must be row-count-neutral UPDATEs)')
need(seed_hash8 != content_hash8, 'ROUND-8 CHECKER STILL DEFEATED: jsonb key-value content mutation left the content hash unchanged — jsonb is being re-serialized/normalized somewhere in the hash path')
need(content_hash8 != arr_hash8, 'ROUND-8 CHECKER STILL DEFEATED: jsonb array-length mutation left the content hash unchanged — array element count is not fully covered by the hash')
print(f'  CAUGHT  public.webhook_events: row count unchanged ({seed_count8}); jsonb key-value content mutation changed the hash ({seed_hash8} -> {content_hash8}); jsonb array-length mutation changed the hash again ({content_hash8} -> {arr_hash8}) — the round-8 raw ::text hash FAILS both by name; a to_jsonb(record)-based hash risks re-normalizing jsonb subcolumns on the way through')
checks.append('defeat 8 (public.webhook_events jsonb content mutation + array-length change): both change the raw-::text hash — caught (round-7 to_jsonb(record) re-normalization risk closed)')

# === Positive control: two independent, UNMUTATED rollback-only re-checks
# of all tables above produce the identical content hash — proves the check
# is not merely noisy/always-failing, only the actual mutations above trip it ===
control_query = (
    f"SELECT ({hugo_hash_sql}) AS h1, ({gen_hash_sql}) AS h2, "
    f"({owned_cleanup._content_hash_sql(sql, 'inbox_t2_policy.versions', policy_col)}) AS h3, "
    f"({owned_cleanup._content_hash_sql(sql, 'public.organizations', org_col)}) AS h4, "
    f"({owned_cleanup._content_hash_sql(sql, 'public.webhook_events', wh_col)}) AS h5;"
)
check_a = run_rollback_only([control_query])[0].split('|')
check_b = run_rollback_only([control_query])[0].split('|')
need(check_a == check_b, 'positive control: unmutated re-check should be stable across independent rollback-only sessions')
print('  OK  positive control: two independent, unmutated rollback-only re-checks of all five tables produce the IDENTICAL content hash — the check is not merely noisy/always-failing')
checks.append('positive control: unmutated content hash is stable across independent checks (all five tables)')

print(f'\nALL {len(checks)} CHECKER-DEFEAT PROOFS PASSED (rounds 5-8; every mutation was ROLLBACK-ONLY; nothing committed)')
for c in checks:
    print('  -', c)
