#!/usr/bin/env python3
"""Actual two-connection absent-baseline races in synthetic owned namespaces."""
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,re,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection/fixture'));from guards import validate_container,validate_cron
sys.path.insert(0,str(P.parent/'inbox-operation-domain'));import sessions
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def sql(q):
 r=subprocess.run(CMD,input="SET statement_timeout='20s';"+q,capture_output=True,text=True,timeout=30)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def lit(v):return "'"+str(v).replace("'","''")+"'"
def uid():return str(uuid.uuid4())
def need(v,label):
 if not v:raise RuntimeError(label)
validate_cron(sql('SHOW cron.launch_active_jobs'));need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','marker')
sessions.configure(CMD,sql)
for name,body in re.findall(r'CREATE (?:OR REPLACE )?FUNCTION ([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)\([^;]*?AS \$\$(.*?)\$\$;',(P/'setup.sql').read_text(),re.S):need(sql(f"SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname={lit(name)}").strip()==body.strip(),'Installed preparation source mismatch')
o,u,c,p,p2,m,conv,session,sequence,enrollment=[uid() for _ in range(10)]
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Preparation race {o}');INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.invalid');INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{o}','{u}','owner','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{session}','{u}',clock_timestamp()+interval '1 hour');INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Synthetic');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{p}','{o}','Race {p}','MO','{c}'),('{p2}','{o}','Race {p2}','MO','{c}');INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body) VALUES('{m}','{o}','{conv}','{c}','{p}','sms','inbound','received','Preparation race');INSERT INTO sequences(id,org_id,name) VALUES('{sequence}','{o}','Preparation race');COMMIT;")
claims=json.dumps({'sub':u,'role':'authenticated','session_id':session,'exp':4102444800});auth=f'SET request.jwt.claims={lit(claims)};SET ROLE authenticated;'
def query(outcome='nurture'):
 canonical=json.dumps({'purpose':'prepare_action','organizationId':o,'requesterId':u,'targets':[{'kind':'conversation','id':conv}],'definition':{'version':1,'steps':[{'type':'outcome','value':outcome}]},'savedAction':None},separators=(',',':'))
 return f'SELECT public.inbox_prepare_action({lit(canonical)},{lit(uid())});'
def race(writer_sql,prepare_query):
 holder=sessions.Session();waiter=sessions.Session(auth)
 holder.barrier('BEGIN;'+writer_sql)
 waiter.send(prepare_query);sessions.blocked(waiter,holder)
 holder.close('COMMIT;');need(holder.result()[0]==0,'Source writer failed')
 waiter.close();code,out,err=waiter.result();need(code==0,'Waiting preparation failed: '+err)
 return json.loads(next(line for line in out.splitlines() if line.startswith('{')))
checks=[]
try:
 # Remove only this synthetic counter to model a pre-capture historical row.
 sql(f"DELETE FROM inbox_operation_domain.target_versions WHERE org_id='{o}' AND conversation_id='{conv}'")
 prepared=race(f"UPDATE messages SET property_id='{p2}' WHERE id='{m}';",query())
 need(prepared['items'][0]['resolution']['property_id']==p2,'Prepared stale mapping after absent-target counter wait')
 checks.append('missing target baseline concurrent message reparent: waiting preparation recomputes actual new property')
 sql(f"DELETE FROM inbox_t2_policy.versions WHERE org_id='{o}' AND namespace='property_identity' AND entity_key={lit(json.dumps([p2]))}")
 prepared=race(f"UPDATE properties SET deleted_at=clock_timestamp() WHERE id='{p2}';",query())
 need(prepared['items'][0]['exclusion_code']=='property_unavailable' and prepared['effect_count']==0,'Prepared stale eligibility after absent-property counter wait')
 checks.append('missing property identity baseline concurrent deletion writer: waiting preparation excludes current row')
 sql(f"UPDATE properties SET deleted_at=NULL WHERE id='{p2}';DELETE FROM inbox_operation_domain.sms_scopes WHERE org_id='{o}' AND contact_id='{c}'")
 prepared=race(f"INSERT INTO sequence_enrollments(id,org_id,sequence_id,property_id,status) VALUES('{enrollment}','{o}','{sequence}','{p}','active');",query('opted_out'))
 snapshot=json.loads(sql(f"SELECT snapshot FROM inbox_operations.preparations WHERE id='{prepared['preparation_id']}'"))
 need(enrollment in snapshot['effects'][0]['dependencies']['sms_scope']['enrollment_ids'],'Prepared stale enrollment set after absent-scope wait')
 checks.append('missing SMS scope baseline concurrent active enrollment insert: waiting preparation captures new enrollment')
 # Existing counter lock: prepare overlaps a committed metadata worker. Source
 # changes either reject stale acceptance or produce a freshly recomputed plan.
 prior=json.loads(sql(auth+query()))
 op=json.loads(sql(auth+f"SELECT public.inbox_accept_action('{prior['preparation_id']}','{prior['idempotency_key']}')"))['operation_id']
 sid=sql(f"SELECT id FROM inbox_operations.steps WHERE org_id='{o}' AND operation_id='{op}'")
 g=sql(f"SELECT inbox_operations.claim_step('{o}','{op}','{sid}')")
 prepared=race(f"SELECT inbox_action_api.execute_step('{o}','{op}','{sid}',{g});",query('not_interested'))
 newop=json.loads(sql(auth+f"SELECT public.inbox_accept_action('{prepared['preparation_id']}','{prepared['idempotency_key']}')"))['operation_id']
 need(newop!=op,'Overlapping fresh prepare reused unrelated operation')
 checks.append('actual worker transaction blocks overlapping preparation; after commit new preparation accepts current revisions')
finally:
 for process in sessions.processes:process.stop()
(P/'concurrency-evidence.json').write_text(json.dumps({'checks':checks,'source_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in P.glob('*.sql')},'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'fixture_org':o,'limits':['No production historical counter deletion','Missing baselines simulated only by deleting this run synthetic counters','Actual deadlock victim/retry schedule requires separate proof']},indent=2)+'\n')
print(f'{len(checks)} actual preparation concurrency groups passed')
