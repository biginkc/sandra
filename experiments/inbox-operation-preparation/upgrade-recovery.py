#!/usr/bin/env python3
if not __debug__:raise SystemExit('Optimized Python refused')
import json,re,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection/fixture'));from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
def sql(q):return subprocess.check_output(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=q,text=True,timeout=30).strip()
def lit(v):return "'"+v.replace("'","''")+"'"
validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong marker')
pattern=r'(CREATE (?:OR REPLACE )?FUNCTION ([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)\([^;]*?AS \$\$(.*?)\$\$;)'
prior={};current={}
for name in ['setup.sql','accept.sql','review.sql']:
 for statement,fn,body in re.findall(pattern,(P/'before-recovery'/name).read_text(),re.S):prior[fn]=body
 for statement,fn,body in re.findall(pattern,(P/name).read_text(),re.S):current[fn]=statement
checks=[]
for name,body in prior.items():
 query=f"SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname={lit(name)}"
 if sql(query).strip()!=body.strip():raise RuntimeError('Prior source differs '+name)
 checks.append(f"DO $$ BEGIN IF ({query}) IS DISTINCT FROM {lit(body)} THEN RAISE EXCEPTION 'Prior source changed';END IF;END $$;")
parts=[statement.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1) for statement in current.values()]
acl="REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_action_api FROM PUBLIC,anon,authenticated,service_role;REVOKE ALL ON FUNCTION public.inbox_recover_operation(uuid,uuid) FROM PUBLIC,anon,service_role;GRANT EXECUTE ON FUNCTION public.inbox_recover_operation(uuid,uuid) TO authenticated;"
sql("BEGIN;SET LOCAL lock_timeout='2s';"+''.join(checks)+"DROP FUNCTION public.inbox_recover_operation(uuid);DROP FUNCTION inbox_action_api.recover(uuid);"+''.join(parts)+acl+'COMMIT;')
print('Exact prior-source recovery lock upgrade installed; no tables reset')
