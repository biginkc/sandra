#!/usr/bin/env python3
"""One-time guarded upgrade of this agent-owned private adapter only."""
import hashlib,json,re,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection/fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q):return subprocess.check_output(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=q,text=True,timeout=30).strip()
validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong marker')
if sql("SELECT to_regclass('inbox_operation_domain.target_versions') IS NULL")!='t':raise RuntimeError('Already upgraded; preserve installed objects')
prior=sql("SELECT pg_get_functiondef('inbox_operation_domain.apply_property_step(uuid,uuid,uuid,bigint)'::regprocedure)")
if 'Target resolution changed' in prior or 'Property effect has no mappings' in prior:raise RuntimeError('Unexpected previous adapter')
# Preserve the installed body that passed the previous five actual runtime groups.
(P/'apply-before-mappings.sql').write_text(prior+'\n')
source=(P/'setup.sql').read_text();start=source.index('-- Metadata target resolution');end=source.index('CREATE FUNCTION inbox_operation_domain.apply_property_step')
definition=re.search(r'CREATE FUNCTION inbox_operation_domain.apply_property_step.*?END \$\$;',source,re.S).group(0)
# Snapshot read above and mutation are compared again under one transaction.
body=prior.split('AS $function$',1)[1].split('$function$',1)[0] if 'AS $function$' in prior else None
if body is None:raise RuntimeError('Unexpected pg_get_functiondef encoding')
escaped=body.replace("'","''")
guard="DO $$ BEGIN IF (SELECT prosrc FROM pg_proc WHERE oid='inbox_operation_domain.apply_property_step(uuid,uuid,uuid,bigint)'::regprocedure) IS DISTINCT FROM '"+escaped+"' THEN RAISE EXCEPTION 'Adapter changed';END IF;END $$;"
sql("BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';"+guard+source[start:end]+definition.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)+'COMMIT;')
(P/'mapping-upgrade-evidence.json').write_text(json.dumps({'prior_function_sha256':hashlib.sha256(prior.encode()).hexdigest(),'source_sha256':hashlib.sha256(source.encode()).hexdigest(),'limits':['Previous installed body preserved; canonical triggers added only to owned T2 fixture','Historical target-version baselines are not seeded by this upgrade']},indent=2)+'\n')
print('Upgraded only private target capture and property adapter')
