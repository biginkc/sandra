#!/usr/bin/env python3
"""Canonical metadata effects through real signed callbacks and durable restarts."""
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent;sys.path.insert(0,str(P.parent/'inbox-projection/fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned']:raise SystemExit('Explicit --run-owned required')
S=json.loads((P/'.runtime-local/state.json').read_text());D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db';DB='sandra_inbox_action_runtime_20260913'
def command(args,input=None,timeout=40):
 r=subprocess.run(args,input=input,text=True,capture_output=True,timeout=timeout)
 if r.returncode:raise RuntimeError(r.stderr[:1500])
 return r.stdout.strip()
def docker(*args):return command(D+list(args))
CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d',DB,'-v','ON_ERROR_STOP=1']
def sql(q):return command(CMD,"SET statement_timeout='20s';SET lock_timeout='3s';"+q)
def need(v,label):
 if not v:raise RuntimeError(label)
def uid():return str(uuid.uuid4())
def lit(v):return "'"+str(v).replace("'","''")+"'"
def wait(predicate,label,seconds=35):
 deadline=time.monotonic()+seconds
 while time.monotonic()<deadline:
  if predicate():return
  time.sleep(.2)
 raise RuntimeError(label)
validate_container(json.loads(docker('inspect',N))[0]);validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM install_fixture.identity')==S['marker']=='sandra-inbox-action-runtime-owned-synthetic','Wrong runtime fixture')
for kind in ['worker','engine']:
 i=json.loads(docker('inspect',S[kind+'_id']))[0]
 need(i['Name']=='/'+S[kind+'_name'] and i['Config']['Labels']['com.bmh.inbox-fixture']==S['label'],'Owned container changed')
def http(path,port=9080,method='GET',body=None):
 js="const r=await fetch("+json.dumps('http://127.0.0.1:'+str(port)+path)+",{method:"+json.dumps(method)+",headers:{'content-type':'application/json'},"+("body:"+json.dumps(json.dumps(body))+"," if body is not None else '')+"signal:AbortSignal.timeout(3000)});console.log(JSON.stringify({status:r.status,body:(await r.text()).slice(0,4096)}));"
 return json.loads(docker('exec',S['worker_id'],'node','--input-type=module','-e',js))
need(http('/discover',method='POST',body={})['status']==401,'Unsigned discovery admitted')
need(http('/invoke/InboxMetadataOperation/run',method='POST',body={})['status']==401,'Unsigned callback admitted')
wait(lambda:http('/readyz')['status']==200,'Worker not ready')
checks=['actual configured SDK rejects unsigned discovery and callback; registered signed endpoint and real readiness available'];operations=[]
# Controlled isolated rollout gate only. The existing user preview DB is untouched.
sql('UPDATE inbox_control.rollout SET serving_enabled=true WHERE singleton')
o,u,a,session=uid(),uid(),uid(),uid()
sql(f"INSERT INTO organizations(id,name) VALUES('{o}','Signed worker owned {o}');INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.invalid'),('{a}','{a}@example.invalid');INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{o}','{u}','owner','active'),('{o}','{a}','member','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{session}','{u}',clock_timestamp()+interval '1 hour')")
def auth():return 'SET request.jwt.claims='+lit(json.dumps({'sub':u,'role':'authenticated','session_id':session,'exp':4102444800}))+';SET ROLE authenticated;'
def prepare(outcome="not_interested"):
 p,c,m,conversation=uid(),uid(),uid(),uid()
 sql(f"INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Runtime');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{p}','{o}','Signed worker {p}','MO','{c}');INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body) VALUES('{m}','{o}','{conversation}','{c}','{p}','sms','inbound','received','Owned durable worker proof')")
 intent={'purpose':'prepare_action','organizationId':o,'requesterId':u,'targets':[{'kind':'conversation','id':conversation}],'definition':{'version':1,'steps':[{'type':'outcome','value':outcome},{'type':'assign','userId':a}]},'savedAction':None}
 prep=json.loads(sql(auth()+'SELECT public.inbox_prepare_action('+lit(json.dumps(intent,separators=(',',':')))+','+lit(uid())+')'))
 need(prep['effect_count']==2,'Unexpected canonical preparation')
 return p,prep
def accept(prep):return json.loads(sql(auth()+f"SELECT public.inbox_accept_action('{prep['preparation_id']}','{prep['idempotency_key']}')"))['operation_id']
def count(op):return int(sql(f"SELECT count(*) FROM inbox_operations.receipts WHERE org_id='{o}' AND operation_id='{op}'"))
def finished(p,op):
 wait(lambda:count(op)==2,'Canonical signed operation did not finish')
 result=json.loads(sql(auth()+f"SELECT public.inbox_operation_status('{op}')"))
 need(result['completed'] and result['result']=='succeeded','Durable status not succeeded')
 need(sql(f"SELECT outreach_dispo='not_interested' AND assigned_user_id='{a}' FROM properties WHERE org_id='{o}' AND id='{p}'")=='t','Canonical values wrong')
 need(sql(f"SELECT count(*) FROM lead_events WHERE org_id='{o}' AND property_id='{p}' AND source_type='inbox_operation_step'")=='2','Duplicate or missing canonical events')
 operations.append({'operation_id':op,'property_id':p,'states':[s['state'] for s in result['steps']]})
# Accepted jobs outlive the submitting session and start without client polling.
docker('stop','-t','3',S['worker_id'])
p,prep=prepare();op=accept(prep);need(count(op)==0,'Worker applied while stopped')
sql(f"DELETE FROM auth.sessions WHERE id='{session}'");session=uid();sql(f"INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{session}','{u}',clock_timestamp()+interval '1 hour')")
docker('start',S['worker_id']);finished(p,op)
checks.append('real authoritative acceptance survives stopped worker and closed original session; signed callback applies outcome and assignment once')
# Hold only the assignee epoch so outcome can commit while assignment blocks.
for restart_engine in [False,True]:
 p,prep=prepare()
 blocker=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 try:
  blocker.stdin.write(f"BEGIN;SELECT user_id FROM inbox_bridge.access_epochs WHERE user_id='{a}' FOR UPDATE;\\echo LOCKED\n");blocker.stdin.flush()
  wait(lambda:bool(sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='{DB}' AND pid<>pg_backend_pid() AND state='idle in transaction' AND query LIKE '%{a}%')")=='t'),'Assignee lock missing',10)
  op=accept(prep);wait(lambda:count(op)==1,'First step did not commit before assignment wait')
  docker('kill',S['worker_id'])
  if restart_engine:docker('stop','-t','3',S['engine_id']);docker('start',S['engine_id'])
  blocker.stdin.write('COMMIT;\n');blocker.stdin.close();blocker.wait(timeout=10)
  need(blocker.returncode==0,'Blocker failed')
  docker('start',S['worker_id']);finished(p,op)
 finally:
  if blocker.poll() is None:
   try:blocker.stdin.write('ROLLBACK;\n');blocker.stdin.close();blocker.wait(timeout=5)
   except Exception:blocker.terminate();blocker.wait(timeout=5)
 checks.append('worker'+(' and persistent Restate' if restart_engine else '')+' restart after first canonical receipt resumes blocked second step without duplicate events')
# No work is pending: readiness must still detect an unavailable engine.
docker('stop','-t','3',S['engine_id'])
wait(lambda:http('/readyz')['status']==503,'Idle worker falsely ready without Restate',10)
docker('start',S['engine_id']);wait(lambda:http('/readyz')['status']==200,'Worker readiness did not recover',30)
connections=int(sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='sandra-inbox-action-worker'"));need(connections<=2,'Action pool exceeded budget')
checks.append('idle engine outage reports503, restart recovers200, action pool remains within two connections')
# Destroy an actual accepted HTTP response before the core sees its body.
docker('stop','-t','3',S['worker_id']);p,prep=prepare();op=accept(prep)
def fault(mode):
 return json.loads(docker('run','--rm','--network','container:'+S['db_container_id'],'--memory','128m','--cpus','.25','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--mount','type=bind,source='+str(P/'.runtime-local/hosts')+',target=/etc/hosts,readonly','--mount','type=bind,source='+str(P/'lost-response.mjs')+',target=/app/lost-response.mjs,readonly','--env-file',str(P/'.runtime-local/worker.env'),S['worker_image'],'node','lost-response.mjs',mode))
lost=fault('lose');need(lost['lost'],'Actual response was not lost')
need(sql(f"SELECT acknowledged_at IS NULL AND generation=1 FROM inbox_operations.dispatch_outbox WHERE org_id='{o}' AND operation_id='{op}'")=='t','Lost response acknowledged outbox')
wait(lambda:sql(f"SELECT lease_until<=clock_timestamp() FROM inbox_operations.dispatch_outbox WHERE org_id='{o}' AND operation_id='{op}'")=='t','Natural dispatch lease did not expire',40)
replayed=fault('retry');need(replayed['acceptance']['status']=='PreviouslyAccepted','Engine created a replacement invocation')
need(sql(f"SELECT acknowledged_at IS NOT NULL AND generation=2 FROM inbox_operations.dispatch_outbox WHERE org_id='{o}' AND operation_id='{op}'")=='t','Same-event replay was not fenced and acknowledged')
docker('start',S['worker_id']);finished(p,op)
checks.append('real HTTP response destroyed after durable acceptance; natural lease expiry retries the same event as PreviouslyAccepted, with one canonical effect per step')
# Actual prepare/worker inversion: preparation holds the target counter;
# worker holds SMS scope; preparation reaches that same scope. Make the worker's
# default1s detector fire before the preparer's5s detector, then verify the exact
# worker statement reported40P01 and retried the same operation/step.
docker('stop','-t','3',S['worker_id']);p,prep=prepare('opted_out');op=accept(prep)
conversation=prep['items'][0]['target_id'];canonical=sql(f"SELECT canonical_input FROM inbox_operations.preparations WHERE id='{prep['preparation_id']}'")
blocker=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
child=None
try:
 blocker.stdin.write(f"SET deadlock_timeout='5s';BEGIN;SELECT revision FROM inbox_operation_domain.target_versions WHERE org_id='{o}' AND conversation_id='{conversation}' FOR UPDATE;\n");blocker.stdin.flush()
 wait(lambda:sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='{DB}' AND state='idle in transaction' AND query LIKE '%{conversation}%')")=='t','Preparation target lock missing',10)
 command_args=D+['run','--rm','--network','container:'+S['db_container_id'],'--memory','128m','--cpus','.25','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--mount','type=bind,source='+str(P/'.runtime-local/hosts')+',target=/etc/hosts,readonly','--mount','type=bind,source='+str(P/'deadlock-step.mjs')+',target=/app/deadlock-step.mjs,readonly','--env-file',str(P/'.runtime-local/worker.env'),S['worker_image'],'node','deadlock-step.mjs',o,op]
 child=subprocess.Popen(command_args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 wait(lambda:sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='{DB}' AND application_name='sandra-inbox-action-deadlock-proof' AND wait_event_type='Lock')")=='t','Actual worker did not wait on preparation',10)
 blocker.stdin.write(auth()+"SELECT public.inbox_prepare_action("+lit(canonical)+","+lit(uid())+");COMMIT;\n");blocker.stdin.close()
 output,error=child.communicate(timeout=20);need(child.returncode==0,'Actual deadlock worker failed: '+error)
 retry=json.loads(output);need(retry['aborted'][0]['code']=='40P01','Worker was not the actual deadlock victim')
 blocker.wait(timeout=10);need(blocker.returncode==0,'Concurrent authoritative preparation failed')
 need(count(op)==1,'Retried first effect receipt missing')
 need(sql(f"SELECT count(*) FROM lead_events WHERE org_id='{o}' AND property_id='{p}' AND source_type='inbox_operation_step'")=='1','Retried effect duplicated canonical event')
 docker('start',S['worker_id']);wait(lambda:count(op)==2,'Restate did not reconcile retried effect')
 state=json.loads(sql(auth()+f"SELECT public.inbox_operation_status('{op}')"));need(state['completed'] and state['result']=='succeeded','Retried operation not succeeded')
 operations.append({'operation_id':op,'property_id':p,'states':[x['state'] for x in state['steps']],'deadlock_retry':retry})
finally:
 if blocker.poll() is None:
  try:blocker.stdin.write('ROLLBACK;\n');blocker.stdin.close();blocker.wait(timeout=5)
  except Exception:blocker.terminate();blocker.wait(timeout=5)
 if child is not None and child.poll() is None:child.terminate();child.wait(timeout=5)
checks.append('actual concurrent authoritative prepare/worker deadlock: worker40P01 victim retries same operation/step, one event, then signed Restate reconciles receipt')
evidence={'checks':checks,'operations':operations,'organization_id':o,'worker_image':S['worker_image'],'restate_image':S['restate_image'],'connections':connections,'source_hashes':{n:hashlib.sha256((P/n).read_bytes()).hexdigest() for n in ['core.mjs','server.mjs','runtime-proof.py','runtime-control.py','fixture-companion.sql','lost-response.mjs','deadlock-step.mjs']},'limits':['Owned full-schema fixture; no production/provider calls','Synthetic SQL JWT claims; separate browser JWT proof still applies']}
(P/'runtime-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(f'{len(checks)} signed canonical worker/restart groups passed')
