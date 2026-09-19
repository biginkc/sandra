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
need(sql("SELECT to_regnamespace('inbox_t2_backfill') IS NULL")=='t','Already installed: preserve prior proof')
sql((P/'setup.sql').read_text())
o,c,c2,c3,p,p2,p3,u,review,reviewconv,duplicateconv,t1,t2=[uid() for _ in range(13)];checks=[];raw=' historical '+uid();cache={}
def mark(name):checks.append({'name':name,'passed':True})
def state():return json.loads(sql(f"SELECT to_jsonb(j) FROM inbox_t2_backfill.jobs j WHERE org_id='{o}'"))
def dirty(cv,kind='known_conversation'):return int(sql(f"SELECT coalesce((SELECT generation FROM inbox_t2_message_capture.dirty WHERE org_id='{o}' AND target_kind='{kind}' AND target_id='{cv}'),0)"))
def claim():
 rows=json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(j)),'[]') FROM inbox_t2_backfill.claim(100,300) j"))
 for row in rows:cache[row['org_id']]=row['claim_token']
 return cache.pop(o)
def batch(token=None,limit=2):return json.loads(sql(f"SELECT inbox_t2_backfill.batch('{o}','{token or claim()}',{limit})"))
def ins(mid,cv,phone='+18165550891'):return f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address) VALUES('{mid}','{o}','{cv}','{c}','{p}','sms','inbound','received','Backfill fixture','{phone}');"
base=(uuid.uuid4().int>>8)<<8;ms=[str(uuid.UUID(int=base+i)) for i in range(10,17)];cs=[uid() for _ in ms]
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Historical backfill {o}');INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Synthetic'),('{c2}','{o}','Synthetic second'),('{c3}','{o}','Synthetic third');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{p}','{o}','Synthetic {p}','MO','{c}'),('{p2}','{o}','Synthetic {p2}','MO','{c2}'),('{p3}','{o}','Synthetic {p3}','MO','{c3}');"+''.join(ins(m,cv) for m,cv in zip(ms,cs))+f"INSERT INTO messages(id,org_id,channel,direction,status,body,from_address) VALUES('{u}','{o}','sms','inbound','received','Unknown historical fixture',{lit(raw)});INSERT INTO ai_disposition_reviews(id,org_id,property_id,conversation_id,source_inbound_message_id,disposition,ai_reason) VALUES('{review}','{o}','{p}','{reviewconv}','{ms[0]}','not_interested','Synthetic');INSERT INTO message_threads(id,org_id,channel,contact_id,property_id,conversation_id) VALUES('{t1}','{o}','sms','{c2}','{p2}','{duplicateconv}'),('{t2}','{o}','sms','{c3}','{p3}','{duplicateconv}');COMMIT;")
oldgroup=sql(f"SELECT sender_group_id FROM inbox_t2_message_capture.sender_groups WHERE org_id='{o}' AND raw_sender={lit(raw)}")
# Honest historical-state model: only freshly created, fixture-owned private entries.
# Canonical rows/triggers stay enabled. No earlier proof state is touched.
sql(f"BEGIN;DELETE FROM inbox_t2_message_capture.route_edges WHERE org_id='{o}';DELETE FROM inbox_t2_message_capture.dirty WHERE org_id='{o}';DELETE FROM inbox_t2_maintained.queue WHERE org_id='{o}';DELETE FROM inbox_t2_message_capture.sender_groups WHERE org_id='{o}' AND sender_group_id='{oldgroup}';DELETE FROM inbox_t2_backfill.collisions WHERE org_id='{o}';COMMIT;")
need(sql(f"SELECT count(*) FROM inbox_t2_message_capture.route_edges WHERE org_id='{o}'")=='0','Historical missing-edge setup')
sql(f"SELECT inbox_t2_backfill.start('{o}')");token=claim();first=batch(token)
need(first['source_rows']==2 and state()['revision']==1,'First batch not bounded/checkpointed')
saved=state();count=sql(f"SELECT count(*) FROM inbox_t2_message_capture.route_edges WHERE org_id='{o}'")
need(batch(token)['result']=='stale_claim' and state()==saved and sql(f"SELECT count(*) FROM inbox_t2_message_capture.route_edges WHERE org_id='{o}'")==count,'Replay changed private state/checkpoint')
mark('bounded historical scan begins with durable checkpoint; replay token cannot advance or duplicate effects')
# Simulated crash before commit: transaction rollback must undo registry, edge and cursor changes.
token=claim();saved=state();before=sql(f"SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY message_id),'[]') FROM inbox_t2_message_capture.route_edges e WHERE org_id='{o}'")
sql(f"BEGIN;SELECT inbox_t2_backfill.batch('{o}','{token}',2);ROLLBACK;")
need(state()==saved and before==sql(f"SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY message_id),'[]') FROM inbox_t2_message_capture.route_edges e WHERE org_id='{o}'"),'Rollback split backfill state');batch(token)
# New arrival behind the committed source cursor is captured independently.
late=str(uuid.UUID(int=uuid.uuid4().int & ((1<<64)-1)));latecv=uid();need(uuid.UUID(late).int<uuid.UUID(state()['cursor']).int,'Late fixture not behind cursor');sql(ins(late,latecv))
need(dirty(latecv)>0 and sql(f"SELECT count(*) FROM inbox_t2_message_capture.route_edges WHERE org_id='{o}' AND message_id='{late}'")=='1','Behind-cursor source arrival missed live capture')
mark('transaction rollback preserves cursor and edges; a behind-cursor arrival is covered by live capture')
# Lease replacement resumes persisted cursor rather than starting another historical job.
token=claim();cursor=state()['cursor'];sql(f"UPDATE inbox_t2_backfill.jobs SET lease_until=statement_timestamp()-interval '1 second',available_at=statement_timestamp()-interval '1 second' WHERE org_id='{o}'")
replacement=claim();need(replacement!=token and state()['cursor']==cursor,'Reclaim reset durable cursor');need(batch(token)['result']=='stale_claim','Expired token accepted');batch(replacement)
for _ in range(30):
 if state()['stream']=='done':break
 batch()
else:raise RuntimeError('Historical drain exceeded bound')
newgroup=sql(f"SELECT sender_group_id FROM inbox_t2_message_capture.sender_groups WHERE org_id='{o}' AND raw_sender COLLATE \"C\"={lit(raw)} COLLATE \"C\"")
need(bool(newgroup) and dirty(newgroup,'unknown_sender')>0,'Absent historical unknown registry not seeded');need(all(dirty(cv)>0 for cv in cs) and dirty(reviewconv)>0,'Known/review target missed')
need(sql(f"SELECT count(*) FROM inbox_t2_message_capture.route_edges WHERE org_id='{o}'")=='8','Historical edge cardinality wrong')
mark('lease reclaim resumes persisted scan; messages/reviews seed retained unknown identity, edges and known/review targets')
# Collisions report two IDs rather than changing canonical identity automatically.
need(sql(f"SELECT inbox_t2_backfill.inspect_collisions('{o}',100)")!='0','No thread collision inspection')
report=json.loads(sql(f"SELECT inbox_t2_backfill.readiness('{o}')"));need(report['historical_scan_complete'] and report['capture_unchanged'] and report['thread_collision_found'] and not report['production_cutover_authorized'],'Collision readiness report wrong')
need(sql(f"SELECT count(*) FROM message_threads WHERE org_id='{o}' AND conversation_id='{duplicateconv}'")=='2','Collision was automatically repaired')
# Deletion invalidates the previous report; a fresh inspection acknowledges only new source generation.
sql(f"DELETE FROM message_threads WHERE id='{t2}'");need(json.loads(sql(f"SELECT inbox_t2_backfill.readiness('{o}')"))['collision_checks_pending'],'Thread change did not queue fresh inspection')
sql(f"SELECT inbox_t2_backfill.inspect_collisions('{o}',100)");need(not json.loads(sql(f"SELECT inbox_t2_backfill.readiness('{o}')"))['thread_collision_found'],'Resolved fixture collision remained current')
# Reintroduce after completed historical cursor; live thread capture must find it.
sql(f"INSERT INTO message_threads(id,org_id,channel,contact_id,property_id,conversation_id) VALUES('{t2}','{o}','sms','{c3}','{p3}','{duplicateconv}')");sql(f"SELECT inbox_t2_backfill.inspect_collisions('{o}',100)");need(json.loads(sql(f"SELECT inbox_t2_backfill.readiness('{o}')"))['thread_collision_found'],'Post-scan duplicate missed')
mark('bounded collision evidence blocks readiness and follows later delete/reinsert without automatic repair')
for role in ['authenticated','service_role']:
 r=sql(f"SET ROLE {role};SELECT * FROM inbox_t2_backfill.jobs",False);need(r.returncode!=0 and '42501' in r.stderr,'Backfill work leaked')
mark('private backfill/collision state inaccessible to ordinary authenticated and service roles')
(P/'evidence.json').write_text(json.dumps({'at':sql('SELECT statement_timestamp()::text'),'checks':checks,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Missing historical private state modeled by deleting only fresh owned fixture entries while capture remained active','No actual process crash; rollback and durable lease-reclaim exercised','Fingerprint verifies endpoints, not privileged trigger bypass between observations','No production cutover, policy-version seeding or SLO claim']},indent=2)+'\n');print(json.dumps({'passed':len(checks),'checks':checks},indent=2))
