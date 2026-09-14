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
if sql("SELECT to_regclass('inbox_operation_domain.shared_sms_receipts') IS NULL")!='t':raise RuntimeError('Already upgraded; preserve fixture')
guards=[]
for file,signature in [('restrictive-effect.sql','inbox_operation_domain.apply_sms_opt_out(uuid,uuid,uuid,uuid,jsonb,jsonb)'),('restrictive-apply.sql','inbox_operation_domain.apply_property_step(uuid,uuid,uuid,bigint)')]:
 previous=(P/'before-sharing'/file).read_text().split('AS $$',1)[1].split('$$;',1)[0]
 if sql(f"SELECT prosrc FROM pg_proc WHERE oid='{signature}'::regprocedure").strip()!=previous.strip():raise RuntimeError('Prior source mismatch: '+signature)
 guards.append("DO $$ BEGIN IF (SELECT prosrc FROM pg_proc WHERE oid='"+signature+"'::regprocedure) IS DISTINCT FROM "+lit(previous)+" THEN RAISE EXCEPTION 'Adapter changed';END IF;END $$;")
scope=(P/'restrictive-scope.sql').read_text();shared=scope[scope.index('CREATE TABLE inbox_operation_domain.shared_sms_receipts'):scope.index('CREATE FUNCTION inbox_operation_domain.capture_sms_scope')]
helper=(P/'restrictive-effect.sql').read_text().replace('BEGIN;','',1).rsplit('COMMIT;',1)[0]
apply=(P/'restrictive-apply.sql').read_text()
sql("BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';"+''.join(guards)+shared+helper+apply+"DROP FUNCTION inbox_operation_domain.apply_sms_opt_out(uuid,uuid,uuid,uuid,jsonb,jsonb);COMMIT;")
(P/'shared-sms-upgrade-evidence.json').write_text(json.dumps({'source_hashes':{name:hashlib.sha256((P/name).read_bytes()).hexdigest() for name in ['restrictive-scope.sql','restrictive-effect.sql','restrictive-apply.sql']},'prior_source_hashes':{name:hashlib.sha256((P/'before-sharing'/name).read_bytes()).hexdigest() for name in ['restrictive-effect.sql','restrictive-apply.sql']},'scope':'Private safety receipt table and two function bodies only; no fixture reset'},indent=2)+'\n')
print('Private shared-contact safety receipt upgrade complete')
