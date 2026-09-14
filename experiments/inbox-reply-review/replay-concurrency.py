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
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL")=='t','Refusing existing schema')
o,u,owner,sess,p,c,contact,m,k=[str(uuid.uuid4()) for _ in range(9)]
paths=[P.parent/'inbox-reply-boundary/context.sql',P.parent/'inbox-reply-preparation/recipient.sql',P.parent/'inbox-reply-preparation/batch.sql',P/'setup.sql'];installed=False;children=[]
def lit(value):return "'"+str(value).replace("'","''")+"'"
auth='SET request.jwt.claims='+lit(json.dumps({'sub':u,'role':'authenticated','session_id':sess,'exp':4102444800}))+';'
try:
 for path in paths:
  sql(path.read_text());installed=True
 sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Owned reply replay expiry {o}');INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.invalid'),('{owner}','{owner}@example.invalid');INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{o}','{u}','owner','active'),('{o}','{owner}','owner','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{sess}','{u}',clock_timestamp()+interval '1 hour');INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES('{contact}','{o}','Ada','+12025550101','mobile');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) SELECT '{p}','{o}','Owned replay property',state,'{contact}' FROM (VALUES('MO'),('HI'),('GU'),('PR')) states(state) WHERE inbox_reply_preparation.quiet_hours(state,clock_timestamp())->>'ok'='true' LIMIT 1;INSERT INTO provider_sender_numbers(org_id,provider,phone_e164,status) VALUES('{o}','sendillo','+18165550101','active');INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES('{m}','{o}','{c}','{contact}','{p}','sms','inbound','received','Owned replay inbound','+12025550101','+18165550101');COMMIT;")
 capture=json.loads(sql(auth+f"SELECT inbox_reply_review.capture(ARRAY['{c}'::uuid])"))['items'][0]
 raw=json.dumps({'targets':[{'kind':'conversation','id':c}],'drafts':[{'conversationId':c,'body':'Owned immutable body','dependencies':capture['dependencies'],'exclusion':None}]},separators=(',',':'))
 original=json.loads(sql(auth+f"SELECT inbox_reply_review.freeze({lit(raw)},'{k}')"))
 need(original['recipientCount']==1,'Initial owned preparation unavailable')
 writer_name='reply-replay-key-holder-'+str(uuid.uuid4());reader_name='reply-replay-expiry-reader-'+str(uuid.uuid4())
 writer=start(f"SET application_name='{writer_name}';BEGIN;SELECT inbox_action_api.lock_request_key('{o}','{u}','{k}');SELECT pg_sleep(4);COMMIT;");children.append(writer)
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{writer_name}' AND wait_event='PgSleep')",'Writer did not hold exact request lock')
 sql(f"UPDATE memberships SET access_expires_at=clock_timestamp()+interval '2 seconds' WHERE org_id='{o}' AND user_id='{u}'")
 reader=start(auth+f"SET application_name='{reader_name}';SELECT inbox_reply_review.freeze({lit(raw)},'{k}')");children.append(reader)
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{reader_name}' AND wait_event_type='Lock')",'Replay did not actually wait')
 out,err=reader.communicate(timeout=12);need(reader.returncode!=0 and ('INBOX_MEMBERSHIP' in err or 'INBOX_ACCESS' in err),'Expired replay was not rejected: '+err)
 need('Owned immutable body' not in out,'Expired replay disclosed body')
 _,err=writer.communicate(timeout=12);need(writer.returncode==0,err)
finally:
 for child in children:
  if child.poll() is None:child.terminate();child.wait(timeout=5)
 if installed:sql('DROP SCHEMA IF EXISTS inbox_reply_review CASCADE;DROP SCHEMA IF EXISTS inbox_reply_preparation CASCADE;DROP SCHEMA IF EXISTS inbox_reply_context CASCADE;')
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL")=='t','Owned schema cleanup failed')
(P/'replay-concurrency-evidence.json').write_text(json.dumps({'sources':{str(path.relative_to(P.parent)):hashlib.sha256(path.read_bytes()).hexdigest() for path in paths},'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'checks':['Existing preparation replay actually waited on exact request key, crossed natural membership expiry, then denied without returning frozen body'],'owned_org_id':o,'cleanup':'Private reply schemas and triggers removed; uniquely marked synthetic source rows retained','limitations':['Trusted SQL JWT claims; no HTTP/providercall or production activation']},indent=2)+'\n')
print('Actual replay access-expiry lock-wait proof passed; private schemas removed')
