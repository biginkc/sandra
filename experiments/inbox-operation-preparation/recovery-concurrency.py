#!/usr/bin/env python3
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection/fixture'));from guards import validate_container,validate_cron
sys.path.insert(0,str(P.parent/'inbox-operation-domain'));import sessions
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def sql(q):
 r=subprocess.run(CMD,input=q,text=True,capture_output=True,timeout=30)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def lit(v):return "'"+str(v).replace("'","''")+"'"
def need(v,label):
 if not v:raise RuntimeError(label)
validate_cron(sql('SHOW cron.launch_active_jobs'));need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','Wrong marker')
for name,path in [('lock_request_key',P/'setup.sql'),('accept',P/'accept.sql'),('recover',P/'review.sql')]:
 body=path.read_text().split('CREATE FUNCTION inbox_action_api.'+name+'(',1)[1].split('AS $$',1)[1].split('$$;',1)[0]
 need(sql(f"SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='inbox_action_api' AND p.proname='{name}'").strip()==body.strip(),'Installed source mismatch '+name)
sessions.configure(CMD,sql)
case=json.loads((P/'expiry-case.json').read_text());auth=f"SET request.jwt.claims={lit(case['claims'])};SET ROLE authenticated;"
canonical=sql(f"SELECT canonical_input FROM inbox_operations.preparations WHERE id='{case['preparation_id']}' AND org_id='{case['org']}'")
key=str(uuid.uuid4());prepared=json.loads(sql(auth+f'SELECT public.inbox_prepare_action({lit(canonical)},{lit(key)})'));prep=prepared['preparation_id']
holder=sessions.Session(auth);waiter=sessions.Session(auth)
try:
 holder.barrier(f"BEGIN;SELECT public.inbox_accept_action('{prep}','{key}');")
 accepted=json.loads(next(line for line in holder.lines if line.startswith('{')))
 waiter.send(f"SELECT public.inbox_recover_operation('{prep}','{key}');")
 sessions.blocked(waiter,holder)
 holder.close('COMMIT;');need(holder.result()[0]==0,'Acceptance did not commit')
 waiter.close();code,out,err=waiter.result();need(code==0,'Recovery waiter failed '+err)
 recovered=json.loads(next(line for line in out.splitlines() if line.startswith('{')))
 need(recovered=={'state':'accepted','operation':accepted},'Recovery returned absence before accepted transaction commit')
finally:
 for process in sessions.processes:process.stop()
(P/'recovery-concurrency-evidence.json').write_text(json.dumps({'checks':['actual acceptance holds original key lock before commit; simultaneous recovery waits for that transaction','after commit recovery returns exact durable accepted identity instead of null'],'operation':accepted,'source_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [P/'setup.sql',P/'accept.sql',P/'review.sql']},'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2)+'\n')
print('Actual late acceptance/recovery lock ordering and retained identity passed')
