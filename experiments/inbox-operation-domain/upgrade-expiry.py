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
prior=(P/'setup-before-expiry.sql').read_text()
if hashlib.sha256(prior.encode()).hexdigest()!='cd7c919a7aa16d42913eba6429f0b11c564b33f39436029020942f8d503aaa3c':raise RuntimeError('Prior source changed')
source=(P/'setup.sql').read_text()
statements=[]
for name,signature in [('capture_target',''),('apply_property_step','uuid,uuid,uuid,bigint')]:
 pattern=r'CREATE FUNCTION inbox_operation_domain\.'+name+r'.*?END \$\$;'
 previous=re.search(pattern,prior,re.S).group(0).split('AS $$',1)[1].split('$$;',1)[0]
 installed=sql(f"SELECT prosrc FROM pg_proc WHERE oid='inbox_operation_domain.{name}({signature})'::regprocedure")
 if installed.strip()!=previous.strip():raise RuntimeError('Installed prior body differs: '+name)
 escaped=previous.replace("'","''")
 statements.append("DO $$ BEGIN IF (SELECT prosrc FROM pg_proc WHERE oid='inbox_operation_domain."+name+"("+signature+")'::regprocedure) IS DISTINCT FROM '"+escaped+"' THEN RAISE EXCEPTION 'Adapter changed';END IF;END $$;")
 statements.append(re.search(pattern,source,re.S).group(0).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
sql("BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';"+''.join(statements)+'COMMIT;')
(P/'expiry-upgrade-evidence.json').write_text(json.dumps({'prior_source_sha256':hashlib.sha256(prior.encode()).hexdigest(),'source_sha256':hashlib.sha256(source.encode()).hexdigest(),'scope':'Only two private function bodies replaced; no schema, data, or other fixture changes'},indent=2)+'\n')
print('Private time-validity upgrade complete')
