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
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL")=='t','Refusing existing schema')
o,p,u,s=[str(uuid.uuid4()) for _ in range(4)];source=(P/'context.sql').read_text();installed=False;children=[];checks=[]
try:
 # Existing pre-trigger rows establish a real missing historical baseline.
 sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Owned reply context concurrency {o}');INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.invalid');INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{u}','{o}','owner','active');INSERT INTO properties(id,org_id,address,state,market) VALUES('{p}','{o}','Owned context concurrency','MO','before');COMMIT;")
 sql(source);installed=True
 sql(f"INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES('{s}','{o}','sendillo','+15550009999','active')")
 for namespace,target,update,field,expected,revision in [
  ('property_market',p,f"UPDATE properties SET market='after' WHERE id='{p}'",'market','after','1'),
  ('sender_inventory',s,f"UPDATE provider_sender_numbers SET status='inactive' WHERE id='{s}'",'status','inactive','2')]:
  writer_name='reply-context-writer-'+str(uuid.uuid4());reader_name='reply-context-reader-'+str(uuid.uuid4())
  writer=start(f"SET application_name='{writer_name}';BEGIN;{update};SELECT pg_sleep(3);COMMIT;");children.append(writer)
  wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{writer_name}' AND wait_event='PgSleep')",'Writer not holding changed version')
  reader=start(f"SET application_name='{reader_name}';SELECT inbox_reply_context.snapshot('{o}','{namespace}','{target}')");children.append(reader)
  wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{reader_name}' AND wait_event_type='Lock')",'Reader did not actually wait on writer')
  out,err=reader.communicate(timeout=12);need(reader.returncode==0,err)
  _,err=writer.communicate(timeout=12);need(writer.returncode==0,err)
  value=json.loads(out.strip());need(value['value'][field]==expected and value['revision']==revision,'Post-wait snapshot used stale source or revision')
  checks.append(namespace+': observed database lock wait; returned committed current value and revision')
finally:
 for child in children:
  if child.poll() is None:child.terminate();child.wait(timeout=5)
 if installed:sql('DROP SCHEMA inbox_reply_context CASCADE;')
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL")=='t','Owned schema cleanup failed')
(P/'context-concurrency-evidence.json').write_text(json.dumps({'source_sha256':hashlib.sha256(source.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'checks':checks,'owned_org_id':o,'cleanup':'New schema and its canonical triggers removed. Small uniquely marked synthetic source rows retained in owned fixture.','limitations':['Owned PostgreSQL proof only; no production activation or provider sends']},indent=2)+'\n')
print('Two actual post-lock snapshot groups passed; temporary context schema removed')
