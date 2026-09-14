#!/usr/bin/env python3
"""Real canonical SQL preparation/acceptance; no trusted snapshot injection."""
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,re,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection/fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def sql(q,error=False):
 r=subprocess.run(CMD,input="SET statement_timeout='20s';SET lock_timeout='3s';"+q,capture_output=True,text=True,timeout=30)
 if error:return r
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def lit(v):return "'"+str(v).replace("'","''")+"'"
def uid():return str(uuid.uuid4())
def need(v,label):
 if not v:raise RuntimeError(label)
validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','marker')
for path in [P/'setup.sql',P/'worker.sql',P/'accept.sql',P/'public-api.sql']:
 for name,body in re.findall(r'CREATE (?:OR REPLACE )?FUNCTION ([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)\([^;]*?AS \$\$(.*?)\$\$;',path.read_text(),re.S):
  need(sql(f"SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname={lit(name)}").strip()==body.strip(),'Installed action source mismatch '+name)
o,u,a,c,p,m,conv,session=[uid() for _ in range(8)]
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Authoritative actions {o}');INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.invalid'),('{a}','{a}@example.invalid');INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{o}','{u}','owner','active'),('{o}','{a}','member','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{session}','{u}',clock_timestamp()+interval '1 hour');INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Synthetic');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{p}','{o}','Action {p}','MO','{c}');INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body) VALUES('{m}','{o}','{conv}','{c}','{p}','sms','inbound','received','Authoritative action fixture');COMMIT;")
claims=json.dumps({'sub':u,'role':'authenticated','session_id':session,'exp':4102444800});auth=f'SET request.jwt.claims={lit(claims)};SET ROLE authenticated;'
checks=[]
def prepare(steps=None,targets=None):
 definition={'version':1,'steps':steps or [{'type':'outcome','value':'not_interested'},{'type':'assign','userId':a}]}
 canonical=json.dumps({'purpose':'prepare_action','organizationId':o,'requesterId':u,'targets':targets or [{'kind':'conversation','id':conv}],'definition':definition,'savedAction':None},separators=(',',':'))
 key=uid();r=json.loads(sql(auth+f'SELECT public.inbox_prepare_action({lit(canonical)},{lit(key)})'))
 need(r['input_hash']==hashlib.sha256(b'sandra:inbox:action:v1\0'+canonical.encode()).hexdigest(),'Hash mismatch')
 return r

def accept(prep):return json.loads(sql(auth+f"SELECT public.inbox_accept_action('{prep['preparation_id']}','{prep['idempotency_key']}')"))
def status(op):return json.loads(sql(auth+f"SELECT public.inbox_operation_status('{op}')"))
def execute(op,s):
 g=sql(f"SELECT inbox_operations.claim_step('{o}','{op}','{s}')");need(g!='','No step claim')
 return json.loads(sql(f"SELECT inbox_action_api.execute_step('{o}','{op}','{s}',{g})"))
prep=prepare();need(prep['affected_property_count']==1 and prep['effect_count']==2 and prep['items'][0]['resolution']['property_id']==p,'Preparation actual mapping')
wrong=sql(auth+f"SELECT public.inbox_accept_action('{prep['preparation_id']}','{uid()}')",True);need(wrong.returncode!=0 and 'IDEMPOTENCY_MISMATCH' in wrong.stderr,'Key mismatch accepted')
accepted=accept(prep);op=accepted['operation_id'];need(accept(prep)==accepted,'Accepted identity replay changed')
st=status(op);need(not st['completed'] and st['result'] is None and all(x['state']=='pending' for x in st['steps']),'Initial status')
for step in st['steps']:execute(op,step['id'])
st=status(op);need(st['completed'] and st['result']=='succeeded' and all(x['state']=='succeeded' for x in st['items']),'Successful completion')
need(sql(f"SELECT outreach_dispo='not_interested' AND assigned_user_id='{a}' FROM properties WHERE id='{p}'")=='t','Canonical values absent')
need(accept(prep)==accepted,'Posteffect accepted replay failed')
checks.append('authenticated preparation derives canonical mapping and hash; key binding, accepted replay, actual outcome+assignment, completed status')
prep2=prepare([{'type':'outcome','value':'nurture'}]);sql(f"UPDATE properties SET outreach_dispo='wrong_number' WHERE id='{p}'")
r=sql(auth+f"SELECT public.inbox_accept_action('{prep2['preparation_id']}','{prep2['idempotency_key']}')",True);need(r.returncode!=0 and 'PREPARATION_CHANGED' in r.stderr,'Stale preparation accepted')
checks.append('canonical edit before acceptance rejected atomically')
prep3=prepare();op3=accept(prep3)['operation_id'];sql(f"UPDATE properties SET outreach_dispo='nurture' WHERE id='{p}'")
steps=status(op3)['steps'];failure=execute(op3,steps[0]['id']);st=status(op3)
need(failure['status']=='conflicted' and failure['code']=='record_changed' and st['completed'] and st['result']=='failed','Conflict did not terminate')
need([x['state'] for x in st['steps']]==['conflicted','blocked'] and st['items'][0]['code']=='record_changed','Successor/item conflict lost')
need(sql(f"SELECT inbox_operations.claim_step('{o}','{op3}','{steps[0]['id']}')")=='','Terminal failure reclaimed')
checks.append('postaccept canonical conflict records durable conflict, blocks successor, completes polling, prevents reclaim')
prep4=prepare();op4=accept(prep4)['operation_id'];steps=status(op4)['steps'];execute(op4,steps[0]['id'])
sql(f"UPDATE memberships SET access_expires_at=clock_timestamp()-interval '1 second' WHERE org_id='{o}' AND user_id='{a}'")
failure=execute(op4,steps[1]['id']);st=status(op4)
need(failure['code']=='assignee_unavailable' and st['completed'] and st['result']=='partial' and st['steps'][0]['state']=='succeeded','Partial result lost')
checks.append('assignee expires after committed outcome; assignment conflicts and partial outcome remains explicit')
sql(f"UPDATE memberships SET access_expires_at=NULL WHERE org_id='{o}' AND user_id='{a}'")
prep5=prepare([{'type':'outcome','value':'opted_out'}]);op5=accept(prep5)['operation_id'];execute(op5,status(op5)['steps'][0]['id'])
need(sql(f"SELECT sms_opted_out FROM contacts WHERE id='{c}'")=='t','Authoritatively prepared SMS effect absent')
checks.append('server-derived SMS contact/scope/policy executes actual opt-out')
for role in ['anon','service_role']:
 for call in [f"public.inbox_prepare_action('{{}}','{uid()}')",f"public.inbox_accept_action('{prep['preparation_id']}','{prep['idempotency_key']}')",f"public.inbox_operation_status('{op}')"]:
  r=sql(f'SET ROLE {role};SELECT {call}',True);need(r.returncode!=0 and '42501' in r.stderr and 'permission denied for function' in r.stderr,'Direct wrapper role denial failed')
checks.append('anon/service_role denied all three public wrappers')
(P/'behavior-evidence.json').write_text(json.dumps({'checks':checks,'source_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in P.glob('*.sql')},'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'fixture_org':o,'limits':['Trusted SQL JWT claims; HTTP cryptographic JWT proof separate','No browser or durable dispatcher runtime proof']},indent=2)+'\n')
print(f'{len(checks)} authoritative action behavior groups passed')
