#!/usr/bin/env python3
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,re,subprocess,sys
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
prior={name:body for _,name,body in re.findall(pattern,(P/'setup-before-runtime-fix.sql').read_text(),re.S)};parts=[];guards=[]
for statement,name,body in re.findall(pattern,(P/'setup.sql').read_text(),re.S):
 query=f"SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname={lit(name)}"
 if sql(query).strip()!=prior[name].strip():raise RuntimeError('Prior function changed '+name)
 guards.append(f"DO $$ BEGIN IF ({query}) IS DISTINCT FROM {lit(prior[name])} THEN RAISE EXCEPTION 'Prior source changed';END IF;END $$;")
 parts.append(statement.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
sql("BEGIN;SET LOCAL lock_timeout='2s';"+''.join(guards)+''.join(parts)+'COMMIT;')
print('Guarded preparation function correction installed; no tables reset')
