#!/usr/bin/env python3
if not __debug__: raise SystemExit('Optimized Python refused before fixture access')
import argparse,hashlib,json,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
parser=argparse.ArgumentParser();parser.add_argument('--run-owned-fixture',action='store_true');args=parser.parse_args()
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
need(sql("SELECT to_regnamespace('inbox_t2_safety') IS NULL")=='t','Already installed: preserve evidence')
sql((P/'setup.sql').read_text())
o,o2,c,c2,prop,conv,m,ev1,ev2,sup=[uid() for _ in range(10)];phone='+18165550871';phone2='+18165550872';checks=[];cache={}
def mark(name):checks.append({'name':name,'passed':True})
def parent(contact,org=o):return int(sql(f"SELECT coalesce((SELECT generation FROM inbox_t2_parent.work WHERE org_id='{org}' AND kind='contact' AND entity_id='{contact}'),0)"))
def dirty(cv,org=o):return int(sql(f"SELECT coalesce((SELECT generation FROM inbox_t2_message_capture.dirty WHERE org_id='{org}' AND target_kind='known_conversation' AND target_id='{cv}'),0)"))
def compute():return json.loads(sql(f"SELECT inbox_t2_summary_contract.compute('{o}','{conv}',statement_timestamp())"))
def route(ph=phone,org=o):return json.loads(sql(f"SELECT to_jsonb(w) FROM inbox_t2_safety.routes w WHERE org_id='{org}' AND phone_e164='{ph}'"))
def claim(ph=phone):
 rows=json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(w)),'[]') FROM inbox_t2_safety.claim(100,300) w"))
 for r in rows:cache[(r['org_id'],r['phone_e164'])]=r['claim_token']
 return cache.pop((o,ph))
def batch(ph=phone,token=None,limit=2):return json.loads(sql(f"SELECT inbox_t2_safety.batch('{o}','{ph}','{token or claim(ph)}',{limit})"))
def ins(mid,cv,ph=phone):return f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address) VALUES('{mid}','{o}','{cv}','{c}','{prop}','sms','inbound','received','Safety fixture','{ph}');"
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Safety capture {o}'),('{o2}','Safety capture {o2}');INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Synthetic'),('{c2}','{o2}','Synthetic');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{prop}','{o}','Synthetic {prop}','MO','{c}');"+ins(m,conv)+"COMMIT;")
g=parent(c);sql(f"INSERT INTO consent_events(id,org_id,contact_id,channel,event_type,occurred_at) VALUES('{ev1}','{o}','{c}','sms','opt_out',statement_timestamp()-interval '2 hours'),('{ev2}','{o}','{c}','sms','opt_in_confirmed',statement_timestamp()-interval '1 hour')")
need(parent(c)==g+2 and compute()['is_opted_out'] is False,'Consent insert ordering')
g=parent(c);sql(f"UPDATE consent_events SET occurred_at=statement_timestamp() WHERE id='{ev1}'")
need(parent(c)==g+1 and compute()['is_opted_out'] is True,'Reordered consent not visible')
g=parent(c);sql(f"DELETE FROM consent_events WHERE id='{ev1}'")
need(parent(c)==g+1 and compute()['is_opted_out'] is False,'Deleting latest consent did not reveal older')
mark('relevant consent insert/time reorder/delete advances parent and exact compute reflects latest state')
g=parent(c);sql(f"UPDATE consent_events SET source='Unrelated',source_detail='{{\"synthetic\":true}}',created_at=statement_timestamp() WHERE id='{ev2}'")
helpid=uid();sql(f"INSERT INTO consent_events(id,org_id,contact_id,channel,event_type) VALUES('{helpid}','{o}','{c}','sms','help_request');UPDATE consent_events SET occurred_at=statement_timestamp() WHERE id='{helpid}'")
need(parent(c)==g,'Source metadata/help request enqueued consent parent')
sql(f"UPDATE consent_events SET event_type='opt_out' WHERE id='{helpid}'");need(parent(c)==g+1,'Help-to-consent entry missed')
g=parent(c);sql(f"UPDATE consent_events SET channel='email' WHERE id='{helpid}'");need(parent(c)==g+1,'SMS departure missed')
g=parent(c);g2=parent(c2,o2);sql(f"UPDATE consent_events SET org_id='{o2}',contact_id='{c2}' WHERE id='{ev2}'")
need(parent(c)==g+1 and parent(c2,o2)==g2+1,'Old/new consent scope missed')
mark('unrelated fields/help excluded; relevant-type entry, channel exit and old/new tenant/contact identities captured')
# Existing canonical message insertion may already have created its tuple thread.
tid=sql(f"SELECT id FROM message_threads WHERE org_id='{o}' AND conversation_id='{conv}' LIMIT 1")
if not tid:
 tid=uid();sql(f"INSERT INTO message_threads(id,org_id,channel,contact_id,property_id,conversation_id) VALUES('{tid}','{o}','sms','{c}','{prop}','{conv}')")
g=dirty(conv);sql(f"UPDATE message_threads SET ai_responder_status='escalated' WHERE id='{tid}'");need(dirty(conv)==g+1 and compute()['ai_responder_status']=='escalated','Responder state missed')
g=dirty(conv);sql(f"UPDATE message_threads SET ai_responder_reason='ignored summary reason',updated_at=statement_timestamp() WHERE id='{tid}'");need(dirty(conv)==g,'Thread unrelated reason invalidated')
cv2=uid();g=dirty(conv);sql(f"UPDATE message_threads SET org_id='{o2}',conversation_id='{cv2}' WHERE id='{tid}'")
need(dirty(conv)==g+1 and dirty(cv2,o2)>0,'Thread identity move missed');g2=dirty(cv2,o2);sql(f"DELETE FROM message_threads WHERE id='{tid}'");need(dirty(cv2,o2)==g2+1,'Thread delete missed')
mark('thread consumed state changes and old/new tenant/conversation moves/deletion captured; reason/timestamp excluded')
# Bounded route source IDs within a fresh random namespace.
base=(uuid.uuid4().int>>8)<<8;ms=[str(uuid.UUID(int=base+i)) for i in range(10,15)];cs=[uid() for _ in ms]
sql('BEGIN;'+''.join(ins(x,y) for x,y in zip(ms,cs))+f"INSERT INTO sms_phone_suppressions(id,org_id,phone_e164,source) VALUES('{sup}','{o}','{phone}','owned fixture');COMMIT;")
need(compute()['is_opted_out'] is True,'Suppression not consumed by actual compute');g=route()['generation'];sql(f"UPDATE sms_phone_suppressions SET source='metadata only',provider='synthetic',suppressed_at=statement_timestamp() WHERE id='{sup}'");need(route()['generation']==g,'Suppression metadata invalidated route')
before={cv:dirty(cv) for cv in [conv]+cs};token=claim();first=batch(token=token)
need(first['source_rows']==2 and sum(dirty(cv)>before[cv] for cv in before)<=2,'Route batch unbounded')
scan=route()['scan_generation'];saved=route();ds={cv:dirty(cv) for cv in before};need(batch(token=token)['result']=='stale_claim' and saved==route() and ds=={cv:dirty(cv) for cv in before},'Route stale replay changed work')
# Move a pre-existing source edge behind cursor into the route; direct message capture covers it.
late=str(uuid.UUID(int=1));latecv=uid()
# Random low namespace keeps fresh identity while making it lower than every source in this scan.
late=str(uuid.UUID(int=(uuid.uuid4().int & ((1<<64)-1))))
sql(ins(late,latecv,phone2));d=dirty(latecv);sql(f"UPDATE messages SET from_address='{phone}' WHERE id='{late}'");need(dirty(latecv)==d+1,'Behind-cursor route change missed direct dirty')
need(sql(f"SELECT phone_e164 FROM inbox_t2_message_capture.route_edges WHERE org_id='{o}' AND message_id='{late}'")==phone,'Edge route not changed')
# Suppression identity move dirties departing route plus the new scoped route while old scan runs.
sql(f"UPDATE sms_phone_suppressions SET phone_e164='{phone2}' WHERE id='{sup}'")
need(route()['generation']>scan and route()['scan_generation']==scan and route(phone2)['generation']==1,'Route identity move reset active scan or missed old/new')
token=claim();saved=route();ds={cv:dirty(cv) for cv in before};sql(f"BEGIN;SELECT inbox_t2_safety.batch('{o}','{phone}','{token}',2);ROLLBACK;");need(saved==route() and ds=={cv:dirty(cv) for cv in before},'Route checkpoint/children rollback split');batch(token=token)
for _ in range(20):
 if route()['scan_generation'] is None:break
 batch()
else:raise RuntimeError('Route active scan exceeded bound')
need(route()['ack']==scan and route()['generation']>scan,'Route acknowledged newer generation')
for _ in range(20):
 if route()['ack']==route()['generation']:break
 batch()
else:raise RuntimeError('Route pending scan exceeded bound')
need(all(dirty(cv)>before[cv] for cv in before),'Route scan missed existing children')
mark('bounded route fanout, source edge moved behind cursor, old/new suppression identity, rollback/replay and captured-generation ack')
# Cross-organization suppression move and deletion retain separate durable work identities.
g=route(phone2)['generation'];sql(f"UPDATE sms_phone_suppressions SET org_id='{o2}' WHERE id='{sup}'");need(route(phone2)['generation']==g+1 and route(phone2,o2)['generation']==1,'Suppression tenant move missed');sql(f"DELETE FROM sms_phone_suppressions WHERE id='{sup}'");need(route(phone2,o2)['generation']==2,'Suppression deletion lost route identity')
mark('suppression tenant move and deletion retain both route generations')
# Transaction failure/rollback does not leave safety work committed.
x=uid();g=parent(c);sql(f"BEGIN;INSERT INTO consent_events(id,org_id,contact_id,channel,event_type) VALUES('{x}','{o}','{c}','sms','opt_out');ROLLBACK;");need(parent(c)==g,'Rolled-back consent leaked generation')
for role in ['authenticated','service_role']:
 r=sql(f"SET ROLE {role};SELECT * FROM inbox_t2_safety.routes",False);need(r.returncode!=0 and '42501' in r.stderr,'Safety routes leaked')
mark('source transaction rollback and private role access restrictions verified')
(P/'evidence.json').write_text(json.dumps({'at':sql('SELECT statement_timestamp()::text'),'checks':checks,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Private summary invalidation only; no command policy versions or production changes','Route edges contain post-capture fixture writes; no production backfill proof','No performance targets, process crash, generic writer retry or provider recovery proof']},indent=2)+'\n')
print(json.dumps({'passed':len(checks),'checks':checks},indent=2))
