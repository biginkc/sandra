#!/usr/bin/env python3
"""Drift-mutation harness for verify.py --installed: applies each drift class to
the live owned fixture, proves verify.py --installed FAILS, restores, proves it
PASSES again. This is the proof that the catalog comparisons in verify.py are
actually load-bearing, not merely present in the source.

Never touches supabase/migrations. Always leaves the fixture in the clean,
correct, serving-disabled state, even on failure (best-effort restore in a
finally per case).
"""
import argparse,json,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--owned-fixture',action='store_true');a=ap.parse_args()
if not a.owned_fixture:raise SystemExit('Explicit owned fixture required')
from fixture_db import guard,sql
guard()

def verify_installed():
 r=subprocess.run([sys.executable,str(P/'verify.py'),'--installed'],capture_output=True,text=True,cwd=str(P))
 return r.returncode,r.stdout,r.stderr

def need(v,label):
 if not v:raise RuntimeError('HARNESS FAILURE: '+label)

results=[]
def run_case(name,apply_fn,restore_fn,fail_substr):
 apply_fn()
 try:
  rc,out,err=verify_installed()
  need(rc!=0,f'{name}: verify.py --installed should have FAILED but exited 0\nstdout={out}\nstderr={err}')
  need(fail_substr.lower() in (out+err).lower(),f'{name}: expected failure to mention {fail_substr!r}, got: {(out+err)[-800:]}')
  drift_caught=True
  drift_error=(out+err).strip().splitlines()[-1] if (out+err).strip() else ''
 finally:
  restore_fn()
 rc,out,err=verify_installed()
 need(rc==0,f'{name}: verify.py --installed should PASS after restore but failed\nstdout={out}\nstderr={err}')
 results.append({'case':name,'drift_caught':drift_caught,'drift_error':drift_error,'restored_pass':True})
 print(f'PASS  {name}')

# 0. Baseline: must pass before we start mutating anything.
rc,out,err=verify_installed()
need(rc==0,'Baseline verify.py --installed must pass before any mutation: '+out+err)
print('PASS  baseline (correct install)')

# 1. rollout_default: serving_enabled column DEFAULT flipped to true.
run_case('rollout_serving_default_true',
 lambda: sql("ALTER TABLE inbox_control.rollout ALTER COLUMN serving_enabled SET DEFAULT true"),
 lambda: sql("ALTER TABLE inbox_control.rollout ALTER COLUMN serving_enabled SET DEFAULT false"),
 'column default drift inbox_control.rollout.serving_enabled')

# 2. disable_trigger: a named capture trigger disabled.
run_case('disable_capture_trigger',
 lambda: sql("ALTER TABLE public.messages DISABLE TRIGGER zzzzz_inbox_message_direct"),
 lambda: sql("ALTER TABLE public.messages ENABLE TRIGGER zzzzz_inbox_message_direct"),
 'installed trigger disabled: zzzzz_inbox_message_direct')

# 3. index_recreated: same name, different columns.
run_case('index_recreated_different_columns',
 lambda: sql("DROP INDEX inbox_bridge.summary_order;CREATE INDEX summary_order ON inbox_bridge.summaries(org_id,target_kind)"),
 lambda: sql("DROP INDEX inbox_bridge.summary_order;CREATE INDEX summary_order ON inbox_bridge.summaries(org_id,latest_at DESC,target_kind,target_id)"),
 'index definition drift')

# 4. disable_rls: cross-tenant exposure at install if this ever silently passed.
run_case('disable_row_level_security',
 lambda: sql("ALTER TABLE inbox_control.rollout DISABLE ROW LEVEL SECURITY"),
 lambda: sql("ALTER TABLE inbox_control.rollout ENABLE ROW LEVEL SECURITY"),
 'row level security disabled')

# 5. trigger retargeted/re-timed: BEFORE INSERT -> AFTER INSERT on the same function.
run_case('trigger_retimed',
 lambda: sql("DROP TRIGGER zzz_inbox_guard_inbound_revision_insert ON public.messages;CREATE TRIGGER zzz_inbox_guard_inbound_revision_insert AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.inbox_guard_inbound_revision()"),
 lambda: sql("DROP TRIGGER zzz_inbox_guard_inbound_revision_insert ON public.messages;CREATE TRIGGER zzz_inbox_guard_inbound_revision_insert BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.inbox_guard_inbound_revision()"),
 'trigger definition drift')

# 6. column_default_flip: a boolean column default flipped false -> true.
run_case('column_default_flip',
 lambda: sql("ALTER TABLE inbox_control.rollout ALTER COLUMN backfill_complete SET DEFAULT true"),
 lambda: sql("ALTER TABLE inbox_control.rollout ALTER COLUMN backfill_complete SET DEFAULT false"),
 'column default drift')

# 7a. weakened_check: ack<=generation dropped, leaving only ack>=0.
run_case('weakened_check_constraint',
 lambda: sql("ALTER TABLE inbox_parent.work DROP CONSTRAINT work_check;ALTER TABLE inbox_parent.work ADD CONSTRAINT work_check CHECK (ack>=0)"),
 lambda: sql("ALTER TABLE inbox_parent.work DROP CONSTRAINT work_check;ALTER TABLE inbox_parent.work ADD CONSTRAINT work_check CHECK (ack>=0 AND ack<=generation)"),
 'constraint definition drift')

# 7b. fk_on_delete_change: an FK with no ON DELETE action gains ON DELETE CASCADE.
run_case('fk_on_delete_added',
 lambda: sql("ALTER TABLE inbox_bridge.cursors DROP CONSTRAINT cursors_scope_id_fkey;ALTER TABLE inbox_bridge.cursors ADD CONSTRAINT cursors_scope_id_fkey FOREIGN KEY (scope_id) REFERENCES inbox_bridge.worksets(id) ON DELETE CASCADE"),
 lambda: sql("ALTER TABLE inbox_bridge.cursors DROP CONSTRAINT cursors_scope_id_fkey;ALTER TABLE inbox_bridge.cursors ADD CONSTRAINT cursors_scope_id_fkey FOREIGN KEY (scope_id) REFERENCES inbox_bridge.worksets(id)"),
 'constraint definition drift')

# 7c. not_valid_readd: an identical CHECK constraint dropped and re-added
# NOT VALID (the classic "drop, let violating rows slip in, re-add NOT VALID
# to dodge the validation scan" attack). convalidated must be true.
run_case('not_valid_readd',
 lambda: sql("ALTER TABLE public.messages DROP CONSTRAINT messages_inbox_inbound_revision_nonnegative;ALTER TABLE public.messages ADD CONSTRAINT messages_inbox_inbound_revision_nonnegative CHECK (inbox_inbound_revision >= 0) NOT VALID"),
 lambda: sql("ALTER TABLE public.messages DROP CONSTRAINT messages_inbox_inbound_revision_nonnegative;ALTER TABLE public.messages ADD CONSTRAINT messages_inbox_inbound_revision_nonnegative CHECK (inbox_inbound_revision >= 0)"),
 'constraint definition drift')

# 7d. rls_forced: FORCE ROW LEVEL SECURITY silently added (changes owner/
# superuser bypass semantics unreviewed).
run_case('force_row_level_security',
 lambda: sql("ALTER TABLE inbox_control.rollout FORCE ROW LEVEL SECURITY"),
 lambda: sql("ALTER TABLE inbox_control.rollout NO FORCE ROW LEVEL SECURITY"),
 'unexpected force row level security')

# 7e. function_volatility_changed: STABLE matching() recreated VOLATILE.
run_case('function_volatility_changed',
 lambda: sql("ALTER FUNCTION inbox_bridge.matching(uuid,uuid,jsonb) VOLATILE"),
 lambda: sql("ALTER FUNCTION inbox_bridge.matching(uuid,uuid,jsonb) STABLE"),
 'function definition drift')

# 8. Unexpected object kind (view) planted in a private companion schema.
run_case('extra_view_in_companion_schema',
 lambda: sql("CREATE VIEW inbox_read.zz_harness_extra_view AS SELECT 1 AS one"),
 lambda: sql("DROP VIEW IF EXISTS inbox_read.zz_harness_extra_view"),
 'extra relations')

# 8b. Unexpected TYPE (domain) planted in a private companion schema -- checked
# via a separate pg_catalog path (pg_type) from the relation check above.
run_case('extra_domain_in_companion_schema',
 lambda: sql("CREATE DOMAIN inbox_read.zz_harness_domain AS text"),
 lambda: sql("DROP DOMAIN IF EXISTS inbox_read.zz_harness_domain"),
 'extra types')

# 8c. Unexpected COMPOSITE TYPE planted in a private companion schema (relkind
# 'c'/typtype 'c') -- Codex-flagged gap: composite types were excluded from
# both the relation scan (relkind filter lacked 'c') and the type scan (a
# naive typtype='c' NOT IN pg_class exclusion, meant to skip every ordinary
# table's own implicit row type, also excluded real standalone composite
# types since they too have a matching pg_class row).
run_case('extra_composite_type_in_companion_schema',
 lambda: sql("CREATE TYPE inbox_read.zz_harness_composite AS (x integer)"),
 lambda: sql("DROP TYPE IF EXISTS inbox_read.zz_harness_composite"),
 'extra relations')

# 8d-8h. Composite-type ATTRIBUTE drift (the G2/#585 gap): verify.py's columns
# snapshot used to be keyed only on CREATE TABLE names, so an ALTER TYPE ...
# DROP/ADD/ALTER/RENAME ATTRIBUTE (or a collation change) on a declared
# composite type -- inbox_bridge.cursor_context -- passed verify.py silently.
# Each case below is asserted by BOTH exit code (via run_case) and an error
# message naming the type (checked below via fail_substr).

# 8d. Drop the last declared attribute.
run_case('composite_attribute_dropped',
 lambda: sql("ALTER TYPE inbox_bridge.cursor_context DROP ATTRIBUTE cursor_target"),
 lambda: sql("ALTER TYPE inbox_bridge.cursor_context ADD ATTRIBUTE cursor_target uuid"),
 'column set drift on inbox_bridge.cursor_context')

# 8e. Add an attribute the source does not declare.
run_case('composite_attribute_added',
 lambda: sql("ALTER TYPE inbox_bridge.cursor_context ADD ATTRIBUTE zz_harness_extra text"),
 lambda: sql("ALTER TYPE inbox_bridge.cursor_context DROP ATTRIBUTE zz_harness_extra"),
 'column set drift on inbox_bridge.cursor_context')

# 8f. Change an attribute's type (boolean -> integer).
run_case('composite_attribute_type_changed',
 lambda: sql("ALTER TYPE inbox_bridge.cursor_context ALTER ATTRIBUTE revoked TYPE integer"),
 lambda: sql("ALTER TYPE inbox_bridge.cursor_context ALTER ATTRIBUTE revoked TYPE boolean"),
 'column type drift inbox_bridge.cursor_context.revoked')

# 8g. Rename an attribute (name changes, type/position do not).
run_case('composite_attribute_renamed',
 lambda: sql("ALTER TYPE inbox_bridge.cursor_context RENAME ATTRIBUTE cursor_kind TO cursor_kind_renamed"),
 lambda: sql("ALTER TYPE inbox_bridge.cursor_context RENAME ATTRIBUTE cursor_kind_renamed TO cursor_kind"),
 'column set drift on inbox_bridge.cursor_context')

# 8h. Give a text attribute an explicit non-default collation.
run_case('composite_attribute_collation_changed',
 lambda: sql('ALTER TYPE inbox_bridge.cursor_context ALTER ATTRIBUTE cursor_kind TYPE text COLLATE "C"'),
 lambda: sql("ALTER TYPE inbox_bridge.cursor_context ALTER ATTRIBUTE cursor_kind TYPE text"),
 'column collation drift inbox_bridge.cursor_context.cursor_kind')

# 9. Conflicting function overload: a second inbox_read.detail(uuid,uuid,text).
run_case('function_overload_added',
 lambda: sql("CREATE FUNCTION inbox_read.detail(o uuid,c uuid,extra text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_read.detail(o,c) $$"),
 lambda: sql("DROP FUNCTION IF EXISTS inbox_read.detail(uuid,uuid,text)"),
 'conflicting overload')

# 10. search_path recreated as public instead of empty.
run_case('search_path_public',
 lambda: sql("ALTER FUNCTION inbox_bridge.authorize(uuid) SET search_path=public"),
 lambda: sql("ALTER FUNCTION inbox_bridge.authorize(uuid) SET search_path=''"),
 'function definition drift')

# 11b. function_strict_drift (Astra-flagged gap): verify.py's function
# snapshot used to compare volatility/SECURITY DEFINER/search_path but not
# STRICT -- an ALTER FUNCTION ... STRICT flip (proisstrict false->true,
# which changes the function to silently return NULL instead of running
# whenever any argument is NULL) passed verify.py --installed silently.
run_case('function_strict_drift',
 lambda: sql("ALTER FUNCTION inbox_bridge.matching(uuid,uuid,jsonb) STRICT"),
 lambda: sql("ALTER FUNCTION inbox_bridge.matching(uuid,uuid,jsonb) CALLED ON NULL INPUT"),
 'function definition drift')

# 11c. check_constraint_arithmetic_regrouping (Astra-flagged gap): verify.py's
# CHECK-constraint leaf comparison used to blanket-strip every paren inside a
# leaf, so "(jsonb_array_length(targets)+99)/100" and
# "jsonb_array_length(targets)+(99/100)" -- different computations --
# compared EQUAL. inbox_bridge.worksets_check already contains exactly this
# expression shape; regroup it without changing any function/column name.
# The regrouped form is genuinely a different computation for this table's
# 28 existing rows (integer-division truncation), so a normal ALTER would
# be rejected by Postgres's own table scan before verify.py ever runs --
# that data-level rejection is not the thing under test here. Add it
# NOT VALID (skips the row scan) so the ALTER itself succeeds; verify.py's
# constraint-definition-text comparison runs and must still fail on the
# TEXT mismatch alone, before it ever reaches the separate "not validated"
# check (confirmed by fail_substr below being the definition-drift message,
# not the not-validated one). Restore re-adds the ORIGINAL expression
# without NOT VALID, which the real data already satisfies (proven by the
# baseline pass before this case runs), so it re-validates cleanly.
run_case('check_constraint_arithmetic_regrouping',
 lambda: sql("ALTER TABLE inbox_bridge.worksets DROP CONSTRAINT worksets_check;"
  "ALTER TABLE inbox_bridge.worksets ADD CONSTRAINT worksets_check "
  "CHECK (jsonb_typeof(handles)='array' AND jsonb_array_length(handles)=greatest(1,jsonb_array_length(targets)+(99/100))) NOT VALID"),
 lambda: sql("ALTER TABLE inbox_bridge.worksets DROP CONSTRAINT worksets_check;"
  "ALTER TABLE inbox_bridge.worksets ADD CONSTRAINT worksets_check "
  "CHECK (jsonb_typeof(handles)='array' AND jsonb_array_length(handles)=greatest(1,(jsonb_array_length(targets)+99)/100))"),
 'constraint definition drift')

# 11d. function_session_replication_role_bypass (Astra round 3, the
# concrete demonstrated gap): verify.py's function snapshot compared only
# search_path from proconfig, not the FULL config array -- so
# `SET session_replication_role = replica` on a capture trigger function
# (inbox_message_capture.capture, fired by zzzzz_inbox_message_direct on
# public.messages -- see disable_capture_trigger above for the same
# trigger) passed silently. session_replication_role=replica makes
# Postgres skip every non-ALWAYS trigger for the REST of that session,
# including this function's own downstream dirty-queue/projection
# triggers -- a real writer-bypass vector, exactly the class the README's
# "Capture-trigger bypass paths" section already treats as a mandatory
# reconciliation event. ALTER FUNCTION ... RESET removes only that one
# config entry, leaving search_path untouched, so restore is exact.
run_case('function_session_replication_role_bypass',
 lambda: sql("ALTER FUNCTION inbox_message_capture.capture() SET session_replication_role=replica",role='supabase_admin'),
 lambda: sql("ALTER FUNCTION inbox_message_capture.capture() RESET session_replication_role",role='supabase_admin'),
 'function definition drift')

# 12. function_owner_changed (Astra round 4, gap #1): pg_get_functiondef
# never renders OWNER TO -- for a SECURITY DEFINER function the OWNER is the
# execution principal, a real privilege escalation vector a byte-exact
# functiondef comparison alone cannot see. Verified separately against
# function-owners.json.
run_case('function_owner_changed',
 lambda: sql("ALTER FUNCTION inbox_bridge.matching(uuid,uuid,jsonb) OWNER TO supabase_admin",role='supabase_admin'),
 lambda: sql("ALTER FUNCTION inbox_bridge.matching(uuid,uuid,jsonb) OWNER TO postgres",role='supabase_admin'),
 'function owner drift')

# 13/14. function_arg_default_changed / function_return_type_changed (Astra
# round 4, gap #2): both an arg DEFAULT and a RETURN TYPE can only be
# changed via DROP+CREATE (Postgres has no ALTER FUNCTION ... ALTER
# PARAMETER, and CREATE OR REPLACE rejects a return-type change outright).
# Rather than hand-copy the function body into this file (a byte-for-byte
# fork that would silently drift out of sync with the real source -- these
# bodies contain comments that ARE part of the stored prosrc, so even a
# whitespace/comment mismatch would make the "restore" leave a function
# that no longer matches source, breaking the PASS-after-restore check for
# reasons unrelated to what this case is testing), extract the EXACT
# verbatim statement text straight out of the freshly-compiled source file
# -- the same file verify.py itself just regenerated -- via the identical
# regex verify.py uses to find it. The mutation is then a single targeted
# substitution (DEFAULT 100 -> DEFAULT 200, or RETURNS integer -> RETURNS
# bigint) applied to that exact text, so restore is always byte-identical
# to source by construction.
import re as _re
def _extract_function_stmt(fname):
 src=(P/'generated/install-candidate.sql').read_text()+'\n'+(P/'generated/read-companion.sql').read_text()
 pat=r'CREATE (?:OR REPLACE )?FUNCTION '+_re.escape(fname)+r'\(.*?RETURNS\s+(?:SETOF\s+)?(?:TABLE\([^)]*\)|[\w.]+)\s+LANGUAGE\s+\w+[\s\S]*?AS \$\$.*?\$\$;'
 m=_re.search(pat,src,_re.S)
 if not m:raise RuntimeError('Could not extract source statement for '+fname)
 return m.group(0)

_peb_revoke="REVOKE ALL ON FUNCTION inbox_read.prune_expired_boundaries(integer) FROM PUBLIC,anon,authenticated,service_role;"
_peb=_extract_function_stmt('inbox_read.prune_expired_boundaries')
if 'DEFAULT 100' not in _peb:raise RuntimeError('Expected DEFAULT 100 in extracted prune_expired_boundaries source; source may have changed -- update this case')
# DROP FUNCTION also drops its own GRANT/REVOKE state -- a freshly CREATEd
# function defaults to PUBLIC EXECUTE, so the REVOKE that source always
# pairs with this CREATE must be replayed too, or "restore" would leave the
# function correctly-defined but newly exposed to anon/authenticated/
# service_role (a real privilege drift the privilege_exposure check then
# correctly flags -- confirmed empirically, not theoretical).
run_case('function_arg_default_changed',
 lambda: sql("DROP FUNCTION inbox_read.prune_expired_boundaries(integer);"+_peb.replace('DEFAULT 100','DEFAULT 200',1)+_peb_revoke),
 lambda: sql("DROP FUNCTION inbox_read.prune_expired_boundaries(integer);"+_peb+_peb_revoke),
 'function definition drift')

_peuc_revoke="REVOKE ALL ON FUNCTION inbox_read.prune_expired_unknown_cursors(integer) FROM PUBLIC,anon,authenticated,service_role;"
_peuc=_extract_function_stmt('inbox_read.prune_expired_unknown_cursors')
if ') RETURNS integer\n' not in _peuc:raise RuntimeError('Expected RETURNS integer in extracted prune_expired_unknown_cursors source; source may have changed -- update this case')
run_case('function_return_type_changed',
 lambda: sql("DROP FUNCTION inbox_read.prune_expired_unknown_cursors(integer);"+_peuc.replace(') RETURNS integer\n',') RETURNS bigint\n',1)+_peuc_revoke),
 lambda: sql("DROP FUNCTION inbox_read.prune_expired_unknown_cursors(integer);"+_peuc+_peuc_revoke),
 'function definition drift')

# 15. check_constraint_string_literal_case (Astra round 4, gap #3): bool_ast
# used to lowercase every leaf, so a CHECK on 'DONE' was indistinguishable
# from one on 'done' -- inbox_backfill.jobs_stream_check's real data
# (2 rows, both stream='done') would genuinely violate an uppercased
# membership list, so this uses NOT VALID (same technique as
# check_constraint_arithmetic_regrouping above) to install the drifted text
# without a real data conflict; restore is the original text, which the
# real data already satisfies, re-validating cleanly.
run_case('check_constraint_string_literal_case',
 lambda: sql("ALTER TABLE inbox_backfill.jobs DROP CONSTRAINT jobs_stream_check;"
  "ALTER TABLE inbox_backfill.jobs ADD CONSTRAINT jobs_stream_check "
  "CHECK (stream IN ('messages','reviews','threads','DONE')) NOT VALID"),
 lambda: sql("ALTER TABLE inbox_backfill.jobs DROP CONSTRAINT jobs_stream_check;"
  "ALTER TABLE inbox_backfill.jobs ADD CONSTRAINT jobs_stream_check "
  "CHECK (stream IN ('messages','reviews','threads','done'))"),
 'constraint definition drift')

# 16. index_predicate_string_literal_case (Astra round 4, gap #3, index
# form): the same case-folding gap inside an index WHERE predicate --
# inbox_backfill.backfill_available's real predicate is `stream<>'done'`;
# recreate it as `stream<>'DONE'` (same columns, same table).
run_case('index_predicate_string_literal_case',
 lambda: sql("DROP INDEX inbox_backfill.backfill_available;"
  "CREATE INDEX backfill_available ON inbox_backfill.jobs(available_at,org_id) WHERE stream<>'DONE'"),
 lambda: sql("DROP INDEX inbox_backfill.backfill_available;"
  "CREATE INDEX backfill_available ON inbox_backfill.jobs(available_at,org_id) WHERE stream<>'done'"),
 'index definition drift')

# 11. Manifest-pinning (self-certification defense): inject a forged
# generated/index-08.sql that redefines summary_order to match a drifted
# (actually installed) definition, alongside real drift on the live index.
# verify.py must still FAIL -- proving it never reads generated/index-*.sql
# files at all (it derives "expected" only from generated/indexes.json +
# generated/read-indexes.json, which build.py/read-companion.py regenerate
# fresh, from pinned source, on every run -- see the rmtree at the top of
# verify.py). The forged file is deleted (not merely restored) since it does
# not belong in the compiler's own output.
def inject_and_drift():
 sql("DROP INDEX inbox_bridge.summary_order;CREATE INDEX summary_order ON inbox_bridge.summaries(org_id,target_kind)")
 (P/'generated').mkdir(exist_ok=True)
 (P/'generated/index-08.sql').write_text("CREATE INDEX CONCURRENTLY summary_order ON inbox_bridge.summaries(org_id,target_kind);\n")
def restore_injection():
 (P/'generated/index-08.sql').unlink(missing_ok=True)
 sql("DROP INDEX inbox_bridge.summary_order;CREATE INDEX summary_order ON inbox_bridge.summaries(org_id,latest_at DESC,target_kind,target_id)")
run_case('index_packet_injection_ignored',inject_and_drift,restore_injection,'index definition drift')
need(not (P/'generated/index-08.sql').exists(),'Injected index-08.sql should have been removed by restore')

(P/'verify-mutation-harness-evidence.json').write_text(json.dumps({'passed':True,'cases':results,'scope':'Owned fixture only; each case: apply drift, verify.py --installed FAILS with the drift-specific error, restore, verify.py --installed PASSES again'},indent=2)+'\n')
print(f'{len(results)} mutation-harness drift classes all correctly caught and restored')
