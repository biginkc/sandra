#!/usr/bin/env python3
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
def uid():return str(uuid.uuid4())
def stop(p):
 if p and p.poll() is None:p.terminate();p.wait(timeout=5)
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0]);validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','marker')
for name,signature in [('capture_collision',''),('fingerprint',''),('start','uuid'),('claim','integer,integer'),('batch','uuid,uuid,integer'),('inspect_collisions','uuid,integer'),('readiness','uuid')]:
 body=(P/'setup.sql').read_text().split('CREATE FUNCTION inbox_t2_backfill.'+name,1)[1].split('AS $$',1)[1].split('$$;',1)[0]
 need(sql(f"SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_backfill.{name}({signature})'::regprocedure").strip()==body.strip(),'Installed source mismatch')
o,c,c2,p1,p2,v,t1,t2=[uid() for _ in range(8)];holder=worker=None
try:
 sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Collision concurrency {o}');INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Synthetic'),('{c2}','{o}','Synthetic');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{p1}','{o}','Synthetic {p1}','MO','{c}'),('{p2}','{o}','Synthetic {p2}','MO','{c2}');INSERT INTO message_threads(id,org_id,channel,contact_id,property_id,conversation_id) VALUES('{t1}','{o}','sms','{c}','{p1}','{v}');COMMIT;")
 generation=int(sql(f"SELECT generation FROM inbox_t2_backfill.collisions WHERE org_id='{o}' AND conversation_id='{v}'"))
 holder=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 holder.stdin.write(f"SET statement_timeout='15s';SET idle_in_transaction_session_timeout='20s';BEGIN;DO $$ BEGIN PERFORM generation FROM inbox_t2_backfill.collisions WHERE org_id='{o}' AND conversation_id='{v}' FOR UPDATE;END $$;\n\\echo held\n");holder.stdin.flush()
 ready,_,_=select.select([holder.stdout],[],[],10);need(bool(ready) and holder.stdout.readline().strip()=='held','Holder barrier missing')
 app='collision-inspector-'+o;worker=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 worker.stdin.write(f"SET statement_timeout='15s';SET application_name='{app}';SELECT inbox_t2_backfill.inspect_collisions('{o}',1);\n");worker.stdin.close()
 deadline=time.monotonic()+5;blocked=False
 while time.monotonic()<deadline:
  if sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{app}' AND cardinality(pg_blocking_pids(pid))>0)")=='t':blocked=True;break
  time.sleep(.02)
 need(blocked,'Inspector did not block after source probe')
 # Holder already owns the collision row; its source trigger can bump it without waiting.
 holder.stdin.write(f"INSERT INTO message_threads(id,org_id,channel,contact_id,property_id,conversation_id) VALUES('{t2}','{o}','sms','{c2}','{p2}','{v}');COMMIT;\n\\q\n");holder.stdin.flush();holder.wait(timeout=5);need(holder.returncode==0,holder.stderr.read())
 worker.wait(timeout=5);need(worker.returncode==0,worker.stderr.read());need(worker.stdout.read().strip()=='1','Inspector result')
 state=json.loads(sql(f"SELECT to_jsonb(x) FROM inbox_t2_backfill.collisions x WHERE org_id='{o}' AND conversation_id='{v}'"))
 need(state['generation']==generation+1 and state['ack']==generation and state['duplicate_thread_ids'] is None,'Older inspection swallowed newer generation')
 sql(f"SELECT inbox_t2_backfill.inspect_collisions('{o}',1)")
 state=json.loads(sql(f"SELECT to_jsonb(x) FROM inbox_t2_backfill.collisions x WHERE org_id='{o}' AND conversation_id='{v}'"))
 need(state['generation']==state['ack'] and set(state['duplicate_thread_ids'])=={t1,t2},'Fresh inspection missed duplicate pair')
 evidence={'at':sql('SELECT statement_timestamp()::text'),'checks':[{'name':'inspector waits after one-thread source probe; concurrent second thread increments generation; old acknowledgement leaves new work pending and subsequent inspection reports exact duplicate pair','passed':True}],'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Real independent sessions and observed lock wait; one scoped collision interleaving, not production performance or exhaustive concurrency proof']}
 (P/'collision-concurrency-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
finally:stop(worker);stop(holder)
