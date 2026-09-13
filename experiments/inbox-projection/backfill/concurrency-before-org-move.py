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
checks=[]
for mode in ['update','delete','late_claim']:
 o,c,e,m,v,newv=[uid() for _ in range(6)];holder=worker=None
 try:
  sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Backfill concurrency {o}');INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Synthetic');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{e}','{o}','Synthetic {e}','MO','{c}');INSERT INTO messages(id,org_id,conversation_id,property_id,contact_id,channel,direction,status,body,from_address) VALUES('{m}','{o}','{v}','{e}','{c}','sms','inbound','received','Backfill concurrency','+18165550895');SELECT inbox_t2_backfill.start('{o}');COMMIT;")
  def claim():return sql(f"SELECT claim_token FROM inbox_t2_backfill.claim(100,300) WHERE org_id='{o}'")
  token=claim();need(bool(token),'Claim missing')
  generation=sql(f"SELECT generation FROM inbox_t2_message_capture.dirty WHERE org_id='{o}' AND target_kind='known_conversation' AND target_id='{v}'")
  holder=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
  mutation=f"UPDATE messages SET from_address='+18165550896',conversation_id='{newv}' WHERE id='{m}'" if mode=='update' else f"DELETE FROM messages WHERE id='{m}'" if mode=='delete' else f"DO $$ BEGIN PERFORM generation FROM inbox_t2_message_capture.dirty WHERE org_id='{o}' AND target_kind='known_conversation' AND target_id='{v}' FOR UPDATE;END $$"
  holder.stdin.write("SET statement_timeout='15s';SET idle_in_transaction_session_timeout='20s';BEGIN;"+mutation+";\n\\echo held\n");holder.stdin.flush()
  ready,_,_=select.select([holder.stdout],[],[],10);need(bool(ready) and holder.stdout.readline().strip()=='held','Holder barrier missing')
  app='backfill-fence-'+o;worker=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  worker.stdin.write(f"SET statement_timeout='15s';SET application_name='{app}';SELECT inbox_t2_backfill.batch('{o}','{token}',2);\n");worker.stdin.close()
  deadline=time.monotonic()+5;blocked=False
  while time.monotonic()<deadline:
   if sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{app}' AND cardinality(pg_blocking_pids(pid))>0)")=='t':blocked=True;break
   time.sleep(.02)
  need(blocked,'Worker source/private lock wait not observed')
  if mode=='late_claim':
   sql(f"UPDATE inbox_t2_backfill.jobs SET lease_until=statement_timestamp()-interval '1 second',available_at=statement_timestamp()-interval '1 second' WHERE org_id='{o}'")
   replacement=claim();need(bool(replacement) and replacement!=token,'Replacement missing')
  holder.stdin.write('COMMIT;\n\\q\n');holder.stdin.flush();holder.wait(timeout=5);need(holder.returncode==0,'Holder failed')
  worker.wait(timeout=5);need(worker.returncode==0,worker.stderr.read());result=json.loads(worker.stdout.read().strip())
  if mode=='update':
   edge=json.loads(sql(f"SELECT to_jsonb(e) FROM inbox_t2_message_capture.route_edges e WHERE org_id='{o}' AND message_id='{m}'"));need(edge['phone_e164']=='+18165550896' and edge['conversation_id']==newv,'Stale backfill overwrote current route/identity');need(result['source_rows']==1,'Updated source not revalidated')
   checks.append({'name':'source UPDATE holds row before backfill snapshot; observed wait resumes current tuple and never restores old edge','passed':True})
  elif mode=='delete':
   need(sql(f"SELECT count(*) FROM inbox_t2_message_capture.route_edges WHERE org_id='{o}' AND message_id='{m}'")=='0' and result['source_rows']==0,'Deleted source edge resurrected')
   checks.append({'name':'source DELETE holds row before backfill snapshot; observed wait skips deleted tuple without edge resurrection','passed':True})
  else:
   need(result['result']=='stale_claim','Old late-fenced batch committed');need(sql(f"SELECT generation FROM inbox_t2_message_capture.dirty WHERE org_id='{o}' AND target_kind='known_conversation' AND target_id='{v}'")==generation,'Late fence leaked child increment')
   need(sql(f"SELECT cursor IS NULL AND revision=0 AND claim_token='{replacement}'::uuid FROM inbox_t2_backfill.jobs WHERE org_id='{o}'")=='t','Late fence overwrote replacement cursor')
   need(json.loads(sql(f"SELECT inbox_t2_backfill.batch('{o}','{replacement}',2)"))['source_rows']==1,'Replacement failed')
   checks.append({'name':'old worker blocks on private child after source locks; replaced claim rolls back all seed/checkpoint effects and replacement progresses','passed':True})
 finally:stop(worker);stop(holder)
evidence={'at':sql('SELECT statement_timestamp()::text'),'checks':checks,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Real independent sessions and observed lock waits; lease expiry simulated by private fixture update','No universal deadlock freedom, production workload or crash recovery claim']}
(P/'concurrency-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
