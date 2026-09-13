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
need(sql("SELECT to_regnamespace('inbox_t2_parent') IS NULL")=='t','Already installed: preserve prior evidence')
sql((P/'setup.sql').read_text())
o,o2,contact,prop,prop2,review,rc,source=[uid() for _ in range(8)];checks=[];cache={}
def mark(name):checks.append({'name':name,'passed':True})
def state(kind,e):return json.loads(sql(f"SELECT to_jsonb(w) FROM inbox_t2_parent.work w WHERE org_id='{o}' AND kind='{kind}' AND entity_id='{e}'"))
def dirty(c):return int(sql(f"SELECT coalesce((SELECT generation FROM inbox_t2_message_capture.dirty WHERE org_id='{o}' AND target_kind='known_conversation' AND target_id='{c}'),0)"))
def claim(kind,e):
 rows=json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(w)),'[]') FROM inbox_t2_parent.claim(100,300) w"))
 for r in rows:cache[(r['org_id'],r['kind'],r['entity_id'])]=r['claim_token']
 return cache.pop((o,kind,e))
def batch(kind,e,token=None,limit=2):return json.loads(sql(f"SELECT inbox_t2_parent.batch('{o}','{kind}','{e}','{token or claim(kind,e)}',{limit})"))
def ins(m,c,p=prop):return f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body) VALUES('{m}','{o}','{c}','{contact}','{p}','sms','inbound','received','Parent fixture');"
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Parent capture {o}'),('{o2}','Parent capture {o2}');INSERT INTO contacts(id,org_id,first_name) VALUES('{contact}','{o}','Parent');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{prop}','{o}','Synthetic {prop}','MO','{contact}'),('{prop2}','{o}','Synthetic {prop2}','MO','{contact}');COMMIT;")
# Ordered source identities exercise behind-cursor arrivals deterministically.
messages=[str(uuid.UUID(int=(1<<120)+i)) for i in range(10,17)];convs=[uid() for _ in messages]
sql('BEGIN;'+''.join(ins(m,c) for m,c in zip(messages,convs))+ins(source,uid(),prop2)+f"INSERT INTO ai_disposition_reviews(id,org_id,property_id,conversation_id,source_inbound_message_id,disposition,ai_reason) VALUES('{review}','{o}','{prop}','{rc}','{source}','not_interested','Synthetic');COMMIT;")
need(dirty(rc)>0,'Review-only direct target absent')
old=state('property',prop);sql(f"UPDATE properties SET updated_at=statement_timestamp() WHERE id='{prop}'")
need(state('property',prop)['generation']==old['generation'],'Unrelated timestamp invalidated parent')
sql(f"UPDATE properties SET address=address||' changed' WHERE id='{prop}'")
need(state('property',prop)['generation']==old['generation']+1,'Consumed address not captured')
mark('property/contact insertion and consumed field change enqueue only parent; unrelated timestamp ignored')
before={c:dirty(c) for c in convs};token=claim('property',prop);first=batch('property',prop,token)
need(first['source_rows']==2 and first['result']=='advanced','Unbounded first batch')
need(sum(dirty(c)>before[c] for c in convs)==2,'Batch expanded more than two children')
scan=state('property',prop)['scan_generation'];sql(f"UPDATE properties SET city='Later parent generation' WHERE id='{prop}'")
need(state('property',prop)['scan_generation']==scan,'Hot parent reset active scan')
# Repeat old token must not enqueue any child or move cursor.
saved=state('property',prop);ds={c:dirty(c) for c in convs}
need(batch('property',prop,token)['result']=='stale_claim' and state('property',prop)==saved and ds=={c:dirty(c) for c in convs},'Replay changed checkpoint or children')
mark('bounded checkpoint advances; newer parent generation preserves active scan; replay token rejected')
# Link created behind committed cursor is covered by direct message capture.
late=str(uuid.UUID(int=(1<<120)+1));lateconv=uid();sql(ins(late,lateconv));need(dirty(lateconv)>0,'Behind-cursor insertion lost')
# Rolled-back whole batch leaves both durable cursor and child counters unchanged.
token=claim('property',prop);saved=state('property',prop);ds={c:dirty(c) for c in convs}
sql(f"BEGIN;SELECT inbox_t2_parent.batch('{o}','property','{prop}','{token}',2);ROLLBACK;")
need(saved==state('property',prop) and ds=={c:dirty(c) for c in convs},'Rollback split progress and enqueue')
need(batch('property',prop,token)['source_rows']==2,'Rolledback batch could not retry')
while state('property',prop)['scan_generation'] is not None:batch('property',prop)
s=state('property',prop);need(s['ack']==scan and s['generation']>s['ack'],'Old scan acknowledged newer parent')
need(all(dirty(c)>before[c] for c in convs) and dirty(rc)>1,'Message or review stream missed child')
mark('rollback/retry preserves atomic progress; review-only links reached; ack retains newer pending generation')
# Claim expiry is simulated explicitly, no wall-clock/crash claim.
token=claim('property',prop);sql(f"UPDATE inbox_t2_parent.work SET lease_until=statement_timestamp()-interval '1 second',available_at=statement_timestamp()-interval '1 second' WHERE org_id='{o}' AND kind='property' AND entity_id='{prop}'")
newtoken=claim('property',prop);need(newtoken!=token,'Reclaim reused token');ds=dirty(lateconv)
need(batch('property',prop,token)['result']=='stale_claim' and dirty(lateconv)==ds,'Expired worker changed state')
batch('property',prop,newtoken)
while state('property',prop)['generation']>state('property',prop)['ack']:batch('property',prop)
need(dirty(lateconv)>ds,'New generation failed to rescan behind-cursor source')
mark('expired lease reclaims with fresh fence; subsequent generation includes earlier cursor positions')
# Review property/conversation move dirties old/new keys directly.
rc2=uid();d=dirty(rc);sql(f"UPDATE ai_disposition_reviews SET conversation_id='{rc2}',property_id='{prop2}' WHERE id='{review}'")
need(dirty(rc)==d+1 and dirty(rc2)>0,'Review move lost departure/destination')
d=dirty(rc2);sql(f"DELETE FROM ai_disposition_reviews WHERE id='{review}'");need(dirty(rc2)==d+1,'Review deletion lost tombstone dependency')
mark('review property/conversation move and deletion capture departed and resulting conversation keys')
# Contact parent visits all source links, not only property homeowner associations.
before={c:dirty(c) for c in convs};batch('contact',contact)
while state('contact',contact)['generation']>state('contact',contact)['ack']:batch('contact',contact)
need(all(dirty(c)>before[c] for c in convs),'Contact stream missed messages')
mark('contact parent fans out by actual message links with bounded source-record cursor')
# Identity/tenant departure with no linked FK constraints, then deletion retains counter.
x=uid();sql(f"INSERT INTO contacts(id,org_id,first_name) VALUES('{x}','{o}','Unlinked');UPDATE contacts SET org_id='{o2}' WHERE id='{x}'")
need(sql(f"SELECT count(*) FROM inbox_t2_parent.work WHERE kind='contact' AND entity_id='{x}'")=='2','Tenant move merged parent identity')
sql(f"DELETE FROM contacts WHERE id='{x}'")
need(sql(f"SELECT generation FROM inbox_t2_parent.work WHERE kind='contact' AND org_id='{o2}' AND entity_id='{x}'")=='2','Deletion reset persistent parent generation')
mark('old/new tenant keys retained separately through contact move and deletion')
for role in ['authenticated','service_role']:
 r=sql(f"SET ROLE {role};SELECT * FROM inbox_t2_parent.work",False);need(r.returncode!=0 and '42501' in r.stderr,'Private parent access leaked')
mark('ordinary authenticated and service roles cannot read private parent work')
(P/'evidence.json').write_text(json.dumps({'at':sql('SELECT statement_timestamp()::text'),'checks':checks,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Owned fixture only; no production migration or representative load evidence','Simulated expiry and transaction rollback, not process-crash or concurrent stale-checkpoint proof','No consent/suppression/thread capture or command-policy versions','No privileged bypass repair or production backfill']},indent=2)+'\n')
print(json.dumps({'passed':len(checks),'checks':checks},indent=2))
