#!/usr/bin/env python3
if not __debug__: raise SystemExit('Optimized Python refused before fixture access')
import argparse,hashlib,json,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
parser=argparse.ArgumentParser();parser.add_argument('--run-owned-fixture',action='store_true');parser.add_argument('--continue-installed',action='store_true');args=parser.parse_args()
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
if args.continue_installed:
 signatures=[('bump','jsonb'),('snapshot','uuid,jsonb')]+[('capture_'+t,'') for t in json.loads((P/'field-map.json').read_text())]
 for name,signature in signatures:
  body=(P/'setup.sql').read_text().split('CREATE FUNCTION inbox_t2_policy.'+name,1)[1].split('AS $$',1)[1].split('$$;',1)[0]
  need(sql(f"SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_policy.{name}({signature})'::regprocedure").strip()==body.strip(),'Installed source mismatch')
else:
 need(sql("SELECT to_regnamespace('inbox_t2_policy') IS NULL")=='t','Already installed: preserve prior evidence')
 sql((P/'setup.sql').read_text())
o,o2,c,c2,p,u,keeper,m,conv,event,sup,review=[uid() for _ in range(12)];checks=[]
def mark(name):checks.append({'name':name,'passed':True})
def v(ns,key,org=o):
 return int(sql(f"SELECT coalesce((SELECT revision FROM inbox_t2_policy.versions WHERE org_id='{org}' AND namespace={lit(ns)} AND entity_key=({lit(json.dumps(key))}::jsonb)::text),0)"))
def allversions():return sql(f"SELECT jsonb_agg(to_jsonb(v) ORDER BY namespace,entity_key) FROM inbox_t2_policy.versions v WHERE org_id='{o}'")
def snap(requirements):return json.loads(sql(f"SELECT inbox_t2_policy.snapshot('{o}',{lit(json.dumps(requirements))}::jsonb)"))
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Policy capture {o}'),('{o2}','Policy capture {o2}');INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.invalid'),('{keeper}','{keeper}@example.invalid');INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{o}','{keeper}','owner','active'),('{o2}','{keeper}','owner','active'),('{o}','{u}','member','active');INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Synthetic'),('{c2}','{o}','Synthetic other');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{p}','{o}','Synthetic {p}','MO','{c}');INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body) VALUES('{m}','{o}','{conv}','{c}','{p}','sms','inbound','received','Policy fixture');COMMIT;")
property_ns=['property_identity','property_policy','property_outcome','property_assignment','property_reply_content'];need(all(v(n,[p])==1 for n in property_ns),'Initial property counters')
# One metadata dependency tuple; every referenced source must have an authoritative seeded counter.
requirements=[{'namespace':n,'key':[p]} for n in property_ns[:4]]+[{'namespace':'membership_access','key':[u]}]
baseline=snap(requirements);need(len(baseline['dependencies'])==5,'Property/requester dependency vector')
missing=sql(f"SELECT inbox_t2_policy.snapshot('{o}','[{{\"namespace\":\"property_identity\",\"key\":[\"{uid()}\"]}}]')",False);need(missing.returncode!=0 and 'Unseeded dependency' in missing.stderr,'Missing historical counter defaulted to zero')
mark('persistent initial property/requester dependency vector is complete; missing authoritative baseline is rejected')
before=allversions();sql(f"UPDATE messages SET read_at=statement_timestamp(),status='delivered',created_at=created_at-interval '1 minute' WHERE id='{m}';UPDATE properties SET address=address,updated_at=statement_timestamp(),last_ai_escalation_reason='display only' WHERE id='{p}';UPDATE memberships SET my_leads_revision=my_leads_revision+1 WHERE org_id='{o}' AND user_id='{u}'")
need(allversions()==before,'Display-only/no-op updates changed action dependencies')
mark('message read/delivery/order display, property no-op/context and membership badge revisions leave action vector unchanged')
before={n:v(n,[p]) for n in property_ns};sql(f"UPDATE properties SET outreach_dispo='not_interested' WHERE id='{p}'")
need(v('property_outcome',[p])==before['property_outcome']+1 and all(v(n,[p])==before[n] for n in property_ns if n!='property_outcome'),'Outcome purpose separation')
before={n:v(n,[p]) for n in property_ns};sql(f"UPDATE properties SET assigned_user_id='{u}',follow_up_at=statement_timestamp()+interval '1 day' WHERE id='{p}'")
need(v('property_assignment',[p])==before['property_assignment']+1 and v('property_reply_content',[p])==before['property_reply_content'],'Assignment changed unrelated reply content')
rev=v('property_policy',[p]);rejected=sql(f"UPDATE properties SET is_training=true WHERE id='{p}'",False);need(rejected.returncode!=0 and 'TRAINING_PROTECTED' in rejected.stderr and v('property_policy',[p])==rev,'Rejected training mutation changed policy');sql(f"UPDATE properties SET status='contacted' WHERE id='{p}'");need(v('property_policy',[p])==rev+1,'Eligibility status flip missed')
rev=v('property_identity',[p]);sql(f"UPDATE properties SET agent_contact_id='{c2}' WHERE id='{p}'");need(v('property_identity',[p])==rev+1,'Property contact reference missed')
rev=v('property_reply_content',[p]);sql(f"UPDATE properties SET zip='64105',city='Kansas City' WHERE id='{p}'");need(v('property_reply_content',[p])==rev+1,'Template property input missed')
mark('outcome, owner/follow-up, eligibility, contact references and template inputs advance separate property purposes')
cp=v('contact_policy',[c]);cc=v('contact_reply_content',[c]);sql(f"UPDATE contacts SET first_name='Updated synthetic' WHERE id='{c}'");need(v('contact_reply_content',[c])==cc+1 and v('contact_policy',[c])==cp,'Name/policy purpose mixed')
cc=v('contact_reply_content',[c]);sql(f"UPDATE contacts SET phone_2='+18165550781',phone_2_type='mobile' WHERE id='{c}'");need(v('contact_policy',[c])==cp+1 and v('contact_reply_content',[c])==cc,'Phone route policy missed')
cp=v('contact_policy',[c]);sql(f"UPDATE contacts SET sms_opted_out=true WHERE id='{c}'");need(v('contact_policy',[c])==cp+1,'Contact opt-out missed');sql(f"UPDATE contacts SET sms_opted_out=false WHERE id='{c}'")
mark('contact template names separated from phone/type and opt-out policy')
sql(f"INSERT INTO consent_events(id,org_id,contact_id,channel,event_type) VALUES('{event}','{o}','{c}','sms','opt_out')");need(v('contact_channel_consent',[c,'sms'])==1,'Consent baseline');before=v('contact_channel_consent',[c,'sms']);sql(f"UPDATE consent_events SET source='audit only',source_detail='{{\"owned\":true}}' WHERE id='{event}'");need(v('contact_channel_consent',[c,'sms'])==before,'Audit detail invalidated consent')
sql(f"UPDATE consent_events SET occurred_at=occurred_at-interval '1 hour' WHERE id='{event}'");need(v('contact_channel_consent',[c,'sms'])==before+1,'Consent ordering missed');before=v('contact_channel_consent',[c,'sms']);sql(f"UPDATE consent_events SET contact_id='{c2}',channel='email' WHERE id='{event}'");need(v('contact_channel_consent',[c,'sms'])==before+1 and v('contact_channel_consent',[c2,'email'])==1,'Consent old/new channel/contact missed');sql(f"DELETE FROM consent_events WHERE id='{event}'");need(v('contact_channel_consent',[c2,'email'])==2,'Consent deletion reset policy')
mark('consent audit noise excluded; event ordering, old/new contact/channel and deletion advance retained channel policy')
phone='+18165550782';phone2='+18165550783';sql(f"INSERT INTO sms_phone_suppressions(id,org_id,phone_e164,source) VALUES('{sup}','{o}','{phone}','Owned')");before=v('route_policy',['sms',phone]);sql(f"UPDATE sms_phone_suppressions SET suppressed_at=suppressed_at+interval '1 second' WHERE id='{sup}'");need(v('route_policy',['sms',phone])==before+1,'Suppressed-at policy change missed')
before=v('route_policy',['sms',phone]);sql(f"UPDATE sms_phone_suppressions SET provider='audit',source_detail='{{\"owned\":true}}' WHERE id='{sup}'");need(v('route_policy',['sms',phone])==before,'Suppression audit metadata invalidated policy')
sql(f"UPDATE sms_phone_suppressions SET org_id='{o2}',phone_e164='{phone2}' WHERE id='{sup}'");need(v('route_policy',['sms',phone])==before+1 and v('route_policy',['sms',phone2],o2)==1,'Suppression old/new scoped route missed')
mark('suppression time is policy-relevant despite summary exclusion; audit fields excluded and old/new scoped route retained')
thread=sql(f"SELECT id FROM message_threads WHERE org_id='{o}' AND conversation_id='{conv}' LIMIT 1")
if not thread:
 thread=uid();sql(f"INSERT INTO message_threads(id,org_id,channel,contact_id,property_id,conversation_id) VALUES('{thread}','{o}','sms','{c}','{p}','{conv}')")
before=v('conversation_identity',[conv]);sql(f"UPDATE message_threads SET ai_responder_status='escalated',ai_responder_reason='display' WHERE id='{thread}'");need(v('conversation_identity',[conv])==before,'Responder display changed identity')
cv2=uid();sql(f"UPDATE message_threads SET conversation_id='{cv2}' WHERE id='{thread}'");need(v('conversation_identity',[conv])==before+1 and v('conversation_identity',[cv2])==1,'Thread old/new identity missed')
sql(f"INSERT INTO ai_disposition_reviews(id,org_id,property_id,conversation_id,source_inbound_message_id,disposition,ai_reason) VALUES('{review}','{o}','{p}','{conv}','{m}','not_interested','Synthetic')")
pr=v('property_reviews',[p]);reply=v('property_reply_content',[p]);sql(f"UPDATE ai_disposition_reviews SET ai_reason='Display-only reason' WHERE id='{review}'");need(v('property_reviews',[p])==pr,'Review reason invalidated action')
sql(f"UPDATE ai_disposition_reviews SET status='superseded',resolved_at=statement_timestamp(),superseded_reason='Synthetic' WHERE id='{review}'");need(v('property_reviews',[p])==pr+1 and v('property_reply_content',[p])==reply,'Review action not separated from prepared reply content')
mark('thread identity excludes responder display; review action/status changes stay separate from reply content')
access=v('membership_access',[u]);sql(f"UPDATE memberships SET access_status='suspended' WHERE org_id='{o}' AND user_id='{u}'");need(v('membership_access',[u])==access+1,'Membership restriction missed')
access=v('membership_access',[u]);sql(f"UPDATE memberships SET hugo_config=hugo_config||'{{\"owned_fixture_permission\":true}}'::jsonb WHERE org_id='{o}' AND user_id='{u}'");need(v('membership_access',[u])==access+1,'Conservative permission configuration change missed')
mark('membership access restriction and conservative effective configuration changes advance access dependency')
# Unlinked entity permits scoped identity moves and delete/reinsert without unrelated canonical FK effects.
x=uid();sql(f"INSERT INTO contacts(id,org_id,first_name) VALUES('{x}','{o}','ABA fixture');UPDATE contacts SET org_id='{o2}' WHERE id='{x}'")
need(v('contact_identity',[x])==2 and v('contact_identity',[x],o2)==1,'Contact org departure/entry missed');sql(f"DELETE FROM contacts WHERE id='{x}';INSERT INTO contacts(id,org_id,first_name) VALUES('{x}','{o2}','ABA recreated')")
need(v('contact_identity',[x],o2)==3 and v('contact_policy',[x],o2)==3,'Delete/reinsert reset dependency revision')
before=allversions();sql(f"BEGIN;UPDATE properties SET zip='99999' WHERE id='{p}';UPDATE contacts SET first_name='Rolled back' WHERE id='{c}';ROLLBACK;");need(allversions()==before,'Rollback leaked dependency increments')
mark('old/new tenant identities retained; deletion/reinsertion cannot reuse a revision; rollback restores all counters')
for role in ['authenticated','service_role']:
 r=sql(f"SET ROLE {role};SELECT * FROM inbox_t2_policy.versions",False);need(r.returncode!=0 and '42501' in r.stderr,'Private policy counters leaked')
mark('ordinary authenticated/service roles cannot read or forge worker-private counters')
(P/'evidence.json').write_text(json.dumps({'at':sql('SELECT statement_timestamp()::text'),'checks':checks,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'field_map_sha256':hashlib.sha256((P/'field-map.json').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Purpose-scoped source counters, not a complete prepared-reply/authorization dependency contract','No provider/business-line/template/global permission config coverage beyond enumerated fields','Historical baseline seeding and execution-time canonical locks/receipt transaction remain required','No production changes or trigger bypass/retry certification']},indent=2)+'\n');print(json.dumps({'passed':len(checks),'checks':checks},indent=2))
