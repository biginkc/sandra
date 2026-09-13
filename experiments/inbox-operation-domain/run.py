#!/usr/bin/env python3
if not __debug__: raise SystemExit('Optimized Python refused before fixture access')
import argparse,hashlib,json,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
parser=argparse.ArgumentParser();parser.add_argument('--run-owned-fixture',action='store_true');parser.add_argument('--continue-installed',action='store_true');parser.add_argument('--old-review-only',action='store_true');parser.add_argument('--target-expiry',action='store_true');args=parser.parse_args()
if not args.run_owned_fixture: raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
def sql(q,check=True):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],input="SET statement_timeout='20s';SET lock_timeout='2s';"+q,capture_output=True,text=True,timeout=30)
 if check and r.returncode: raise RuntimeError(r.stderr)
 return r.stdout.strip() if check else r
def need(value,label):
 if value is not True: raise RuntimeError(label)
def uid():return str(uuid.uuid4())
def lit(v):return "'"+str(v).replace("'","''")+"'"
validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','marker')

for name,signature in [('snapshot','uuid,jsonb'),('validate_key','text,jsonb')]:
 body=(P.parent/'inbox-projection/policy-versions/setup.sql').read_text().split('CREATE FUNCTION inbox_t2_policy.'+name,1)[1].split('AS $$',1)[1].split('$$;',1)[0]
 need(sql(f"SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_policy.{name}({signature})'::regprocedure").strip()==body.strip(),'Installed policy source mismatch')
if args.continue_installed:
 import re
 for path in [P.parent/'inbox-operation-acceptance/setup.sql',P/'setup.sql']:
  for match in re.finditer(r'CREATE FUNCTION ([\w.]+)\([^;]*?AS \$\$(.*?)\$\$;',path.read_text(),re.S):
   name,body=match.groups()
   need(sql(f"SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname={lit(name)}").strip()==body.strip(),'Installed core/domain source mismatch')
else:
 need(sql("SELECT to_regnamespace('inbox_operations') IS NULL")=='t','Core already installed; do not overwrite')
 sql((P.parent/'inbox-operation-acceptance/setup.sql').read_text())
 sql((P/'setup.sql').read_text())
o,u,a,c,p,m,conv,review,prep,op,step1,step2,item=[uid() for _ in range(13)]
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Domain {o}');INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.invalid'),('{a}','{a}@example.invalid');INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{o}','{a}','owner','active'),('{o}','{u}','member','active');INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Synthetic');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id,follow_up_at) VALUES('{p}','{o}','Synthetic {p}','MO','{c}',clock_timestamp()+interval '1 day');INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body) VALUES('{m}','{o}','{conv}','{c}','{p}','sms','inbound','received','Domain fixture');INSERT INTO ai_disposition_reviews(id,org_id,property_id,conversation_id,source_inbound_message_id,disposition,ai_reason) VALUES('{review}','{o}','{p}','{conv}','{m}','not_interested','Synthetic');COMMIT;")
if args.old_review_only:sql(f"UPDATE messages SET created_at=clock_timestamp()-interval '100 days' WHERE id='{m}'")
if args.target_expiry:sql(f"UPDATE messages SET created_at=clock_timestamp()-interval '2160 hours'+interval '8 seconds' WHERE id='{m}'")
req=[{'namespace':n,'key':[p]} for n in ['property_identity','property_policy','property_outcome','property_assignment','property_reviews']]+[{'namespace':'membership_access','key':[who]} for who in sorted([u,a])]
vector=json.loads(sql(f"SELECT inbox_t2_policy.snapshot('{o}',{lit(json.dumps(req))})"))
targets=[{'conversation_id':conv,'revision':sql(f"SELECT revision FROM inbox_operation_domain.target_versions WHERE org_id='{o}' AND conversation_id='{conv}'")}]
definition={'version':1,'steps':[{'type':'outcome','value':'nurture'},{'type':'assign','userId':a}]}
canonical=json.dumps({'purpose':'prepare_action','organizationId':o,'requesterId':u,'targets':[{'kind':'conversation','id':conv}],'definition':definition,'savedAction':None},separators=(',',':'))
hash_=hashlib.sha256(b'sandra:inbox:action:v1\0'+canonical.encode()).hexdigest()
# Trusted fixture preparation only: the production acceptance function remains
# fail-closed. This slice proves canonical execution, not public preparation.
sql(f"BEGIN;INSERT INTO inbox_operations.preparations VALUES('{prep}','{o}','{u}',{lit(canonical)},'{hash_}',{lit(json.dumps(definition))},'{{}}',clock_timestamp()+interval '1 hour');INSERT INTO inbox_operations.operations(org_id,id,requester_id,idempotency_key,input_hash,preparation_id,definition) VALUES('{o}','{op}','{u}','{uid()}','{hash_}','{prep}',{lit(json.dumps(definition))});INSERT INTO inbox_operations.items VALUES('{o}','{op}','{item}','conversation','{conv}','{{\"property_id\":\"{p}\"}}',NULL);INSERT INTO inbox_operations.steps(org_id,operation_id,id,effect_key,ordinal,action,payload,dependencies,predecessor_id) VALUES('{o}','{op}','{step1}','property:{p}',0,'outcome','{{\"property_id\":\"{p}\",\"value\":\"nurture\"}}',{lit(json.dumps({'policy':vector,'targets':targets}))},NULL),('{o}','{op}','{step2}','property:{p}',1,'assign','{{\"property_id\":\"{p}\",\"user_id\":\"{a}\"}}',{lit(json.dumps({'policy':vector,'targets':targets}))},'{step1}');INSERT INTO inbox_operations.item_steps VALUES('{o}','{op}','{item}','{step1}'),('{o}','{op}','{item}','{step2}');COMMIT;")
g=sql(f"SELECT inbox_operations.claim_step('{o}','{op}','{step1}')")
result=sql(f"SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{step1}',{g})",False)
if result.returncode: raise RuntimeError(result.stderr)
need(sql(f"SELECT outreach_dispo='nurture' AND follow_up_at IS NULL FROM properties WHERE id='{p}'")=='t','Canonical outcome/followup')
need(sql(f"SELECT status FROM ai_disposition_reviews WHERE id='{review}'")=='superseded','Canonical review trigger')
if args.target_expiry:
 first=json.loads(result.stdout.strip())
 need(first['target_revisions'][0]['valid_until'] is not None,'Authoritative time boundary missing')
 before=sql(f"SELECT revision FROM inbox_operation_domain.target_versions WHERE org_id='{o}' AND conversation_id='{conv}'")
 sql(f"SELECT pg_sleep(greatest(0,extract(epoch FROM ('{first['target_revisions'][0]['valid_until']}'::timestamptz-clock_timestamp())))+0.1)")
 need(sql(f"SELECT revision FROM inbox_operation_domain.target_versions WHERE org_id='{o}' AND conversation_id='{conv}'")==before,'Expiry test changed source revision')
 need(json.loads(sql(f"SELECT inbox_t2_summary_contract.compute('{o}','{conv}',clock_timestamp())")).get('exists') is False,'Canonical target did not expire')
 g2=sql(f"SELECT inbox_operations.claim_step('{o}','{op}','{step2}')")
 expired=sql(f"SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{step2}',{g2})",False)
 need(expired.returncode!=0 and 'Target resolution expired' in expired.stderr,'Expired target assignment accepted: '+expired.stderr)
 need(sql(f"SELECT assigned_user_id IS NULL FROM properties WHERE id='{p}'")=='t','Expired assignment applied')
 need(sql(f"SELECT count(*) FROM inbox_operations.receipts WHERE operation_id='{op}'")=='1','Expired step wrote receipt')
 (P/'target-expiry-evidence.json').write_text(json.dumps({'checks':[{'name':'actual 90-day target expiration between outcome and assignment rejects without source revision change','passed':True}],'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256((P/'run.py').read_bytes()).hexdigest(),'fixture_operation_id':op,'valid_until':first['target_revisions'][0]['valid_until']},indent=2)+'\n')
 print('Actual target expiry rejected; outcome retained, assignment and receipt absent')
 raise SystemExit(0)
g2=sql(f"SELECT inbox_operations.claim_step('{o}','{op}','{step2}')")
result2=sql(f"SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{step2}',{g2})",False)
if result2.returncode: raise RuntimeError(result2.stderr)
need(sql(f"SELECT assigned_user_id='{a}' FROM properties WHERE id='{p}'")=='t','Dependent assignment')
need(sql(f"SELECT count(*) FROM inbox_operations.receipts WHERE operation_id='{op}'")=='2','Two receipts')
# A fresh later step detects an external edit rather than treating it as the
# prior step's own revision. Roll back the edit so this fixture remains bounded.
if args.old_review_only:sql(f"UPDATE messages SET created_at=clock_timestamp() WHERE id='{m}'")
targets=[{'conversation_id':conv,'revision':sql(f"SELECT revision FROM inbox_operation_domain.target_versions WHERE org_id='{o}' AND conversation_id='{conv}'")}]
third=uid();current=json.loads(sql(f"SELECT inbox_t2_policy.snapshot('{o}',{lit(json.dumps(req))})"))
sql(f"INSERT INTO inbox_operations.steps(org_id,operation_id,id,effect_key,ordinal,action,payload,dependencies) VALUES('{o}','{op}','{third}','property:{p}',2,'outcome','{{\"property_id\":\"{p}\",\"value\":\"not_interested\"}}',{lit(json.dumps({'policy':current,'targets':targets}))});INSERT INTO inbox_operations.item_steps VALUES('{o}','{op}','{item}','{third}')")
g3=sql(f"SELECT inbox_operations.claim_step('{o}','{op}','{third}')")
conflict=sql(f"BEGIN;UPDATE properties SET follow_up_at=clock_timestamp()+interval '2 days' WHERE id='{p}';SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{third}',{g3});COMMIT;",False)
need(conflict.returncode!=0 and 'Dependency conflict' in conflict.stderr,'External edit was not rejected')
need(sql(f"SELECT count(*) FROM inbox_operations.receipts WHERE operation_id='{op}'")=='2','Conflict wrote receipt')
rollback=sql(f"BEGIN;SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{third}',{g3});SELECT 1/0;COMMIT;",False)
need(rollback.returncode!=0 and 'division by zero' in rollback.stderr,'Post-effect rollback was not reached')
need(sql(f"SELECT outreach_dispo='nurture' FROM properties WHERE id='{p}'")=='t','Canonical effect survived rollback')
need(sql(f"SELECT count(*) FROM inbox_operations.receipts WHERE operation_id='{op}'")=='2','Receipt survived rollback')
need(sql(f"SELECT count(*) FROM lead_events WHERE source_type='inbox_operation_step' AND source_id='{third}'")=='0','Event survived rollback')
revoked=sql(f"BEGIN;UPDATE memberships SET access_expires_at=clock_timestamp()-interval '1 second' WHERE org_id='{o}' AND user_id='{u}';SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{third}',{g3});COMMIT;",False)
need(revoked.returncode!=0 and ('Requester access revoked' in revoked.stderr or 'Requester membership ambiguous or missing' in revoked.stderr),'Revocation test did not reach requester check: '+revoked.stderr)
missing=sql(f"BEGIN;DELETE FROM inbox_operations.item_steps WHERE org_id='{o}' AND operation_id='{op}' AND step_id='{third}';SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{third}',{g3});COMMIT;",False)
need(missing.returncode!=0 and 'Property effect has no mappings' in missing.stderr,'Empty mappings accepted')
p2=uid();sql(f"INSERT INTO properties(id,org_id,address,state) VALUES('{p2}','{o}','Reparent fixture {p2}','MO')")
reparent=sql(f"BEGIN;UPDATE messages SET property_id='{p2}' WHERE id='{m}';SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{third}',{g3});COMMIT;",False)
need(reparent.returncode!=0 and 'Target resolution changed' in reparent.stderr,'Message reparent accepted')
reorder=sql(f"BEGIN;UPDATE messages SET created_at=created_at+interval '1 minute' WHERE id='{m}';SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{third}',{g3});COMMIT;",False)
need(reorder.returncode!=0 and 'Target resolution changed' in reorder.stderr,'Message ordering change accepted')
rebased=sql(f"BEGIN;UPDATE messages SET property_id='{p2}' WHERE id='{m}';UPDATE inbox_operations.steps SET dependencies=jsonb_set(dependencies,'{{targets}}',jsonb_build_array(jsonb_build_object('conversation_id','{conv}','revision',(SELECT revision::text FROM inbox_operation_domain.target_versions WHERE org_id='{o}' AND conversation_id='{conv}')))) WHERE org_id='{o}' AND operation_id='{op}' AND id='{third}';SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{third}',{g3});COMMIT;",False)
need(rebased.returncode!=0 and 'Canonical target property changed' in rebased.stderr,'Canonical resolution was not independently checked')
before_target=sql(f"SELECT revision FROM inbox_operation_domain.target_versions WHERE org_id='{o}' AND conversation_id='{conv}'")
sql(f"UPDATE messages SET read_at=clock_timestamp(),status='delivered' WHERE id='{m}'")
need(sql(f"SELECT revision FROM inbox_operation_domain.target_versions WHERE org_id='{o}' AND conversation_id='{conv}'")==before_target,'Display read/delivery changed target identity')
other=uid();sql(f"INSERT INTO organizations(id,name) VALUES('{other}','Ambiguous fixture {other}');INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{other}','{a}','owner','active')")
ambiguous=sql(f"BEGIN;INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{other}','{u}','member','active');SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{third}',{g3});COMMIT;",False)
need(ambiguous.returncode!=0 and 'Requester membership ambiguous or missing' in ambiguous.stderr,'Ambiguous membership accepted')
sql(f"SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{third}',{g3})")
replay=sql(f"SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{third}',{g3})",False)
need(replay.returncode!=0 and 'Stale step claim' in replay.stderr,'Completed effect replayed')
need(sql(f"SELECT count(*) FROM lead_events WHERE source_type='inbox_operation_step' AND source_id='{third}'")=='1','Repeated event')
print('Canonical effects, revision handoff, external conflicts, rollback, revocation and replay passed')
(P/('old-review-evidence.json' if args.old_review_only else 'evidence.json')).write_text(json.dumps({'checks':[{'name':name,'passed':True} for name in ['canonical outcome/followup/review supersession and dependent assignment','external edit conflict','canonical effect/event/receipt transaction rollback','current requester revocation','completed replay retains one event','zero mappings denied','message reparent changes target dependency','global ambiguous requester denied','ordering changes conflict','canonical recompute rejects rebased wrong property','read/delivery do not invalidate metadata target','old-review-only outcome then assignment' if args.old_review_only else 'recent conversation outcome then assignment']],'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256((P/'run.py').read_bytes()).hexdigest(),'fixture_operation_id':op},indent=2)+'\n')
