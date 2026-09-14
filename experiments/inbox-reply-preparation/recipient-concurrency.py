#!/usr/bin/env python3
"""Two real connections: verify post-lock snapshots, including missing baseline."""
import hashlib,json,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
def need(v,label):
 if not v:raise RuntimeError(label)
def sql(q):
 r=subprocess.run(CMD,input="SET statement_timeout='10s'; SET lock_timeout='5s';"+q,text=True,capture_output=True,timeout=15)
 need(r.returncode==0,r.stderr);return r.stdout.strip()
def start(q):
 p=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 p.stdin.write("SET statement_timeout='10s'; SET lock_timeout='5s';"+q);p.stdin.close();p.stdin=None;return p
def wait_for(query,label):
 deadline=time.monotonic()+5
 while time.monotonic()<deadline:
  if sql(query)=='t':return
  time.sleep(.05)
 raise RuntimeError(label)
validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture')
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL")=='t','Refusing existing schema')
o,p,c,contact,m,s=[str(uuid.uuid4()) for _ in range(6)]
context=(P.parent/'inbox-reply-boundary/context.sql').read_text();source=(P/'recipient.sql').read_text();installed=False;children=[]
try:
 sql(context);installed=True;sql(source)
 sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Owned reply expiry wait {o}');INSERT INTO contacts(id,org_id,phone_1,phone_1_type) VALUES('{contact}','{o}','+12025550101','mobile');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{p}','{o}','Owned expiry property','MO','{contact}');INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES('{s}','{o}','sendillo','+18165550101','active');COMMIT;")
 writer_name='reply-expiry-writer-'+str(uuid.uuid4());reader_name='reply-expiry-reader-'+str(uuid.uuid4())
 writer=start(f"SET application_name='{writer_name}';BEGIN;SELECT 1 FROM inbox_reply_context.versions WHERE org_id='{o}' AND namespace='sender_inventory' AND target_id='{s}' FOR UPDATE;SELECT pg_sleep(4);COMMIT;");children.append(writer)
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{writer_name}' AND wait_event='PgSleep')",'Writer did not hold context lock')
 sql(f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address,created_at) VALUES('{m}','{o}','{c}','{contact}','{p}','sms','inbound','received','Owned expiring inbound','+12025550101','+18165550101',clock_timestamp()-interval '90 days'+interval '2 seconds')")
 reader=start(f"SET application_name='{reader_name}';SELECT inbox_reply_preparation.recipient('{o}','{c}')");children.append(reader)
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{reader_name}' AND wait_event_type='Lock')",'Reader did not actually wait')
 out,err=reader.communicate(timeout=12);need(reader.returncode==0,err)
 _,err=writer.communicate(timeout=12);need(writer.returncode==0,err)
 result=json.loads(out.strip());need(result.get('exclusion')=='conversation_window_expired','Time-only expiration not excluded after real lock wait: '+str(result))
finally:
 for child in children:
  if child.poll() is None:child.terminate();child.wait(timeout=5)
 if installed:sql('DROP SCHEMA IF EXISTS inbox_reply_preparation CASCADE;DROP SCHEMA inbox_reply_context CASCADE;')
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL")=='t','Owned schema cleanup failed')
(P/'recipient-concurrency-evidence.json').write_text(json.dumps({'source_sha256':hashlib.sha256(source.encode()).hexdigest(),'context_sha256':hashlib.sha256(context.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'checks':['Actual pg_stat_activity Lock wait at sender context; natural 90-day expiry during wait excluded at capture completion'],'owned_org_id':o,'cleanup':'Private reply schemas and triggers removed; uniquely marked synthetic source rows retained in owned fixture','limitations':['Single recipient expiry proof; no public preparation, acceptance or provider call']},indent=2)+'\n')
print('Actual recipient natural-expiry lock-wait proof passed; temporary schemas removed')
