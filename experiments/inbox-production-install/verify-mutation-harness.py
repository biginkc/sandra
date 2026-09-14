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
 'constraint not validated on public.messages')

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
 'volatility drift on inbox_bridge.matching')

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

# 9. Conflicting function overload: a second inbox_read.detail(uuid,uuid,text).
run_case('function_overload_added',
 lambda: sql("CREATE FUNCTION inbox_read.detail(o uuid,c uuid,extra text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_read.detail(o,c) $$"),
 lambda: sql("DROP FUNCTION IF EXISTS inbox_read.detail(uuid,uuid,text)"),
 'conflicting overload')

# 10. search_path recreated as public instead of empty.
run_case('search_path_public',
 lambda: sql("ALTER FUNCTION inbox_bridge.authorize(uuid) SET search_path=public"),
 lambda: sql("ALTER FUNCTION inbox_bridge.authorize(uuid) SET search_path=''"),
 'search_path drift')

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
