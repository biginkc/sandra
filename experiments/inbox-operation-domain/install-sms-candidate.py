#!/usr/bin/env python3
"""Owned private fixture upgrade only; never a production migration."""
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,re,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection/fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
def sql(q):return subprocess.check_output(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=q,text=True,timeout=30).strip()
def lit(v):return "'"+v.replace("'","''")+"'"
validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong marker')
if sql("SELECT to_regclass('inbox_operation_domain.sms_scopes') IS NULL")!='t':raise RuntimeError('SMS scope exists; do not overwrite')
source=(P/'setup.sql').read_text()
if hashlib.sha256(source.encode()).hexdigest()!='b7ca70de5cfe321ad3996b98de2f6097ba9b0545e7e2eb7bb0c955e9cc2a35ff':raise RuntimeError('Reviewed source changed')
prior=source.split('CREATE FUNCTION inbox_operation_domain.apply_property_step',1)[1].split('AS $$',1)[1].split('$$;',1)[0]
canonical_path=P.parents[1]/'supabase/migrations/20260830092331_switchboard_contact_preferences.sql'
canonical=canonical_path.read_text().split('create or replace function public.guard_locked_property_sequence_enrollment()',1)[1].split('as $$',1)[1].split('$$;',1)[0]
guards=[]
for name,body in [('inbox_operation_domain.apply_property_step(uuid,uuid,uuid,bigint)',prior),('public.guard_locked_property_sequence_enrollment()',canonical)]:
 if sql(f"SELECT prosrc FROM pg_proc WHERE oid='{name}'::regprocedure").strip()!=body.strip():raise RuntimeError('Installed function mismatch: '+name)
 guards.append("DO $$ BEGIN IF (SELECT prosrc FROM pg_proc WHERE oid='"+name+"'::regprocedure) IS DISTINCT FROM "+lit(body)+" THEN RAISE EXCEPTION 'Source changed during upgrade';END IF;END $$;")
coverage="SELECT count(*) FROM pg_trigger WHERE tgrelid='public.sequence_enrollments'::regclass AND tgfoid='public.guard_locked_property_sequence_enrollment()'::regprocedure AND tgtype=31 AND tgenabled IN ('O','A') AND tgqual IS NULL AND NOT tgisinternal"
if sql(coverage)!='1':raise RuntimeError('Canonical writer coverage missing')
guards.append("DO $$ BEGIN IF ("+coverage+")<>1 THEN RAISE EXCEPTION 'Writer coverage changed';END IF;END $$;")
parts=[]
for name in ['restrictive-scope.sql','restrictive-effect.sql','restrictive-apply.sql']:
 text=(P/name).read_text()
 if name!='restrictive-apply.sql':text=text.replace('BEGIN;','',1).rsplit('COMMIT;',1)[0]
 parts.append(text)
sql("BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';"+''.join(guards)+''.join(parts)+'COMMIT;')
(P/'sms-install-evidence.json').write_text(json.dumps({'source_hashes':{name:hashlib.sha256((P/name).read_bytes()).hexdigest() for name in ['setup.sql','restrictive-scope.sql','restrictive-effect.sql','restrictive-apply.sql']},'canonical_guard_sha256':hashlib.sha256(canonical.encode()).hexdigest(),'writer_trigger':'BEFORE ROW INSERT/UPDATE/DELETE, unconditional, enabled','limits':['Private fixture only','No historical scope baseline','No caller grants or routes enabled']},indent=2)+'\n')
print('Owned SMS candidate installed with exact canonical writer coverage')
