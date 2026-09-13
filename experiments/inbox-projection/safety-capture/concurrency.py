#!/usr/bin/env python3
"""Actual blocked batch versus lease replacement; installed fixture only."""
if not __debug__:raise SystemExit('Optimized Python refused')
import argparse,hashlib,json,select,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
p=argparse.ArgumentParser();p.add_argument('--run-owned-fixture',action='store_true');a=p.parse_args()
if not a.run_owned_fixture:raise SystemExit('Explicit fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db';CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
def sql(q):
 r=subprocess.run(CMD,input="SET statement_timeout='20s';SET lock_timeout='2s';"+q,text=True,capture_output=True,timeout=30)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def need(v,m):
 if v is not True:raise RuntimeError(m)
def stop(p):
 if p and p.poll() is None:p.terminate();p.wait(timeout=5)
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0]);validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','marker')
for name,signature in [('consent_capture',''),('thread_capture',''),('suppression_capture',''),('claim','integer,integer'),('batch','uuid,text,uuid,integer')]:
 body=(P/'setup.sql').read_text().split('CREATE FUNCTION inbox_t2_safety.'+name,1)[1].split('AS $$',1)[1].split('$$;',1)[0]
 need(sql(f"SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_safety.{name}({signature})'::regprocedure").strip()==body.strip(),'Installed source mismatch')
o,c,e,m,v=[str(uuid.uuid4()) for _ in range(5)];phone='+18165550879';holder=worker=None
try:
 sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Safety concurrency {o}');INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Synthetic');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{e}','{o}','Synthetic {e}','MO','{c}');INSERT INTO messages(id,org_id,conversation_id,property_id,contact_id,channel,direction,status,body,from_address) VALUES('{m}','{o}','{v}','{e}','{c}','sms','inbound','received','Safety concurrency','{phone}');INSERT INTO sms_phone_suppressions(org_id,phone_e164,source) VALUES('{o}','{phone}','owned fixture concurrency');COMMIT;")
 def claim():return sql(f"SELECT claim_token FROM inbox_t2_safety.claim(100,300) WHERE org_id='{o}' AND phone_e164='{phone}'")
 token=claim();need(bool(token),'claim missing')
 generation=sql(f"SELECT generation FROM inbox_t2_message_capture.dirty WHERE org_id='{o}' AND target_kind='known_conversation' AND target_id='{v}'")
 holder=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 holder.stdin.write(f"SET statement_timeout='15s';SET idle_in_transaction_session_timeout='20s';BEGIN;DO $$ BEGIN PERFORM generation FROM inbox_t2_message_capture.dirty WHERE org_id='{o}' AND target_kind='known_conversation' AND target_id='{v}' FOR UPDATE;END $$;\n\\echo held\n");holder.stdin.flush()
 ready,_,_=select.select([holder.stdout],[],[],10);need(bool(ready) and holder.stdout.readline().strip()=='held','lock barrier')
 app='route-fence-'+o;worker=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 worker.stdin.write(f"SET statement_timeout='15s';SET application_name='{app}';SELECT inbox_t2_safety.batch('{o}','{phone}','{token}',2);\n");worker.stdin.close()
 deadline=time.monotonic()+5;blocked=False
 while time.monotonic()<deadline:
  if sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{app}' AND cardinality(pg_blocking_pids(pid))>0)")=='t':blocked=True;break
  time.sleep(.02)
 need(blocked,'worker never blocked on child')
 sql(f"UPDATE inbox_t2_safety.routes SET lease_until=statement_timestamp()-interval '1 second',available_at=statement_timestamp()-interval '1 second' WHERE org_id='{o}' AND phone_e164='{phone}'")
 replacement=claim();need(bool(replacement) and replacement!=token,'replacement missing')
 holder.stdin.write('COMMIT;\n\\q\n');holder.stdin.flush();holder.wait(timeout=5);need(holder.returncode==0,'holder failed')
 worker.wait(timeout=5);need(worker.returncode==0,worker.stderr.read());result=json.loads(worker.stdout.read().strip());need(result['result']=='stale_claim','old batch passed fence')
 need(sql(f"SELECT generation FROM inbox_t2_message_capture.dirty WHERE org_id='{o}' AND target_kind='known_conversation' AND target_id='{v}'")==generation,'stale subtransaction leaked child update')
 need(sql(f"SELECT cursor IS NULL AND claim_token='{replacement}'::uuid FROM inbox_t2_safety.routes WHERE org_id='{o}' AND phone_e164='{phone}'")=='t','stale batch changed replacement cursor/token')
 result=json.loads(sql(f"SELECT inbox_t2_safety.batch('{o}','{phone}','{replacement}',2)"));need(result['result']=='completed','replacement failed to make progress')
 evidence={'at':sql('SELECT statement_timestamp()::text'),'checks':[{'name':'real route worker blocks after edge snapshot; replaced claim fences old cursor and rolls back child enqueue; replacement progresses','passed':True}],'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Lease expiry simulated by fixture-private update; actual concurrent sessions and lock wait verified','No process crash, deadlock freedom, production workload or provider execution claim']}
 (P/'concurrency-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
finally:
 stop(worker);stop(holder)
