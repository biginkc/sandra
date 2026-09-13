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
validate_cron(sql('SHOW cron.launch_active_jobs'))
def need(value,label):
 if value is not True: raise RuntimeError(label)
def lit(v): return "'"+str(v).replace("'","''")+"'"
def uid():return str(uuid.uuid4())
need(sql("SELECT marker FROM inbox_t2_fixture.identity")=='sandra-inbox-projection-t2-owned-synthetic','marker')
need(sql("SELECT to_regnamespace('inbox_t2_maintained') IS NULL")=='t','Already installed; preserve prior evidence')
sql((P/'setup.sql').read_text())
o,c,contact,m,u=[uid() for _ in range(5)];raw='synthetic-'+u;at=sql('SELECT statement_timestamp()::text');checks=[]
def mark(name):checks.append({'name':name,'passed':True})
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Maintained model {o}');INSERT INTO contacts(id,org_id,first_name) VALUES('{contact}','{o}','Synthetic');INSERT INTO messages(id,org_id,conversation_id,contact_id,channel,direction,status,body,created_at) VALUES('{m}','{o}','{c}','{contact}','sms','inbound','received','known initial',{lit(at)});INSERT INTO messages(id,org_id,channel,direction,status,from_address,body,created_at) VALUES('{u}','{o}','sms','inbound','received',{lit(raw)},'unknown initial',{lit(at)});COMMIT;")
group=sql(f"SELECT sender_group_id FROM inbox_t2_message_capture.sender_groups WHERE org_id='{o}' AND raw_sender={lit(raw)}")
def snap(kind,target,clock=at):return json.loads(sql(f"SELECT inbox_t2_maintained.snapshot('{o}',{lit(kind)},'{target}',{lit(clock)})"))
def publish(value):return sql(f'SELECT inbox_t2_maintained.publish({lit(json.dumps(value))}::jsonb)')
def state(kind,target):return json.loads(sql(f"SELECT to_jsonb(p)||jsonb_build_object('current_generation',d.generation::text) FROM inbox_t2_maintained.rows p JOIN inbox_t2_message_capture.dirty d USING(org_id,target_kind,target_id) WHERE org_id='{o}' AND target_kind={lit(kind)} AND target_id='{target}'"))
a=snap('known_conversation',c);b=snap('unknown_sender',group)
need(b['summary']['sender_group_id']==group and b['summary']['identity_mapping_required'] is False,'actual unknown identity not bound')
need(publish(a)=='applied' and publish(b)=='applied','initial publish')
need(state('known_conversation',c)['summary']==a['summary'] and state('unknown_sender',group)['summary']==b['summary'],'exact full outputs')
mark('actual known/unknown computations publish through one typed model with persistent group identity')
sql(f"UPDATE messages SET body='older captured' WHERE id='{m}'");old=snap('known_conversation',c)
sql(f"UPDATE messages SET body='newer pending' WHERE id='{m}'");need(publish(old)=='applied','older progress');s=state('known_conversation',c)
need(int(s['current_generation'])>s['source_generation'] and s['summary']['last_message_preview']=='older captured','pending lost')
new=snap('known_conversation',c);need(publish(new)=='applied','new progress');published=state('known_conversation',c)
need(publish(old)=='invalid_generation' and state('known_conversation',c)==published,'stale overwrite')
mark('older captured generation leaves pending repair; subsequent publication rejects stale results')
sql(f"UPDATE messages SET dismissed_at=statement_timestamp() WHERE id='{u}'");b=snap('unknown_sender',group);need(b['summary']['visible_dismissed'] is True and publish(b)=='applied','dismissal update');sql(f"DELETE FROM messages WHERE id='{u}'");b=snap('unknown_sender',group);need(b['summary']['exists'] is False and publish(b)=='applied','unknown tombstone');need(sql(f"SELECT sender_group_id FROM inbox_t2_message_capture.sender_groups WHERE org_id='{o}' AND raw_sender={lit(raw)}")==group,'registry lost')
mark('direct unknown dismissal/deletion updates stored group and retains identity after tombstone')
s=state('known_conversation',c);deadline=s['next_expiry'];later=sql(f"SELECT ({lit(deadline)}::timestamptz+interval '1 microsecond')::text")
def wake(clock,revision=s['revision']):return sql(f"SELECT inbox_t2_maintained.wake_expiry('{o}','known_conversation','{c}',{revision},{lit(clock)})")
need(wake(deadline)=='f','inclusive cutoff expired early');before=state('known_conversation',c)
r=sql(f"BEGIN;SELECT inbox_t2_maintained.wake_expiry('{o}','known_conversation','{c}',{s['revision']},{lit(later)});ROLLBACK;")
need(state('known_conversation',c)==before,'rolledback wake changed state');need(wake(later)=='t' and wake(later)=='f','expiry duplicate wake');after=state('known_conversation',c);need(int(after['current_generation'])==int(before['current_generation'])+1,'expiry generation')
expired=snap('known_conversation',c,later);need(expired['summary']['exists'] is False and publish(expired)=='applied','expiry tombstone')
need(wake(later)=='f','stale schedule revision accepted')
mark('expiry deadline is inclusive; atomic wake survives retry/rollback and publishes tombstone with new generation')
for role in ['authenticated','service_role']:
 r=sql(f"SET ROLE {role};SELECT * FROM inbox_t2_maintained.rows",False);need(r.returncode!=0 and '42501' in r.stderr,'private access leaked')
mark('ordinary authenticated/service roles cannot read private maintained rows')
(P/'evidence.json').write_text(json.dumps({'at':sql('SELECT statement_timestamp()::text'),'checks':checks,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Private unified publication and expiry primitive; no continuous worker scheduling or parent fanout','Trusted worker candidates, not an authenticated public API','No production writes or representative performance measurement']},indent=2)+'\n')
print(json.dumps({'passed':len(checks),'checks':checks},indent=2))
