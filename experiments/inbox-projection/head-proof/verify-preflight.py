#!/usr/bin/env python3
if not __debug__:
    raise SystemExit('Refusing optimized Python: proof assertions must remain enabled')
import json,subprocess,sys,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'fixture'))
from guards import validate_container,validate_cron
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
def sql(s):return subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],input=s,text=True,capture_output=True,timeout=15)
validate_cron(sql('SHOW cron.launch_active_jobs;').stdout.strip())
if sql('SELECT marker FROM inbox_t2_fixture.identity;').stdout.strip()!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong marker')
countsql='SELECT (SELECT count(*) FROM messages),(SELECT count(*) FROM organizations),(SELECT count(*) FROM inbox_inbound_heads);'
before=sql(countsql).stdout
result=subprocess.run([sys.executable,str(HERE/'run.py')],text=True,capture_output=True,timeout=30)
if result.returncode==0 or 'Candidate already installed; refusing before any fixture writes' not in result.stderr:raise RuntimeError('Preflight did not refuse')
if before!=sql(countsql).stdout:raise RuntimeError('Preflight changed row counts')
checks=[{'name':'installed-candidate preflight refuses before any fixture inserts','passed':True}]
for role in ['authenticated','service_role']:
 for statement in ['SELECT * FROM public.inbox_inbound_heads;','UPDATE public.inbox_inbound_heads SET revision=revision+1;']:
  error=sql(f'SET ROLE {role};'+statement)
  if error.returncode==0 or '42501' not in error.stderr or 'permission denied' not in error.stderr:raise RuntimeError('Expected precise42501 privilege denial')
  checks.append({'name':role+' '+statement.split()[0]+' head ACL returns42501 permission denied','passed':True})
for name in ['run.py','supplement.py']:
 result=subprocess.run([sys.executable,'-O',str(HERE/name)],text=True,capture_output=True,timeout=10)
 if result.returncode!=1 or 'Refusing optimized Python' not in result.stderr:raise RuntimeError('Expected optimizedPython refusal')
checks.append({'name':'both head proof entrypoints reject optimizedPython','passed':True})
evidence={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checks':checks,'limits':['Read-only validation; original schema-install evidence preserved','Row counts compare bounded exclusive fixture before and after refused entrypoint']}
(HERE/'guard-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
