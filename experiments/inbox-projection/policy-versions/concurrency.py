#!/usr/bin/env python3
if not __debug__:raise SystemExit('Optimized Python refused')
import argparse,hashlib,json,select,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
p=argparse.ArgumentParser();p.add_argument('--run-owned-fixture',action='store_true');a=p.parse_args()
if not a.run_owned_fixture:raise SystemExit('Explicit fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db';CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
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
for name,signature in [('validate_key','text,jsonb'),('bump','jsonb'),('snapshot','uuid,jsonb')]+[('capture_'+t,'') for t in json.loads((P/'field-map.json').read_text())]:
 body=(P/'setup.sql').read_text().split('CREATE FUNCTION inbox_t2_policy.'+name,1)[1].split('AS $$',1)[1].split('$$;',1)[0]
 need(sql(f"SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_policy.{name}({signature})'::regprocedure").strip()==body.strip(),'Installed source mismatch')
checks=[]
for mode in ['commit','rollback','repeatable_read']:
 o,c,p1,m1,m2,v1,v2,r1,r2=[uid() for _ in range(9)];holder=worker=None
 try:
  sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Policy concurrency {o}');INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Synthetic');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{p1}','{o}','Synthetic {p1}','MO','{c}');INSERT INTO messages(id,org_id,conversation_id,property_id,contact_id,channel,direction,status,body) VALUES('{m1}','{o}','{v1}','{p1}','{c}','sms','inbound','received','Policy concurrency one'),('{m2}','{o}','{v2}','{p1}','{c}','sms','inbound','received','Policy concurrency two');COMMIT;")
  def ins(r,m,v):return f"INSERT INTO ai_disposition_reviews(id,org_id,property_id,conversation_id,source_inbound_message_id,disposition,ai_reason) VALUES('{r}','{o}','{p1}','{v}','{m}','not_interested','Owned concurrent');"
  holder=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
  holder.stdin.write("SET statement_timeout='15s';SET idle_in_transaction_session_timeout='20s';BEGIN;"+ins(r1,m1,v1)+"\n\\echo held\n");holder.stdin.flush()
  ready,_,_=select.select([holder.stdout],[],[],10);need(bool(ready) and holder.stdout.readline().strip()=='held','Holder barrier')
  app='policy-counter-'+o;worker=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  txn="BEGIN ISOLATION LEVEL REPEATABLE READ;DO $$ BEGIN PERFORM count(*) FROM inbox_t2_policy.versions;END $$;" if mode=='repeatable_read' else 'BEGIN;'
  worker.stdin.write(f"SET statement_timeout='15s';SET application_name='{app}';"+txn+ins(r2,m2,v2)+'COMMIT;\n');worker.stdin.close()
  deadline=time.monotonic()+5;blocked=False
  while time.monotonic()<deadline:
   if sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{app}' AND cardinality(pg_blocking_pids(pid))>0)")=='t':blocked=True;break
   time.sleep(.02)
  need(blocked,'Shared property review version did not serialize independent source inserts')
  holder.stdin.write(('ROLLBACK;' if mode=='rollback' else 'COMMIT;')+'\n\\q\n');holder.stdin.flush();holder.wait(timeout=5);need(holder.returncode==0,holder.stderr.read())
  worker.wait(timeout=5);err=worker.stderr.read()
  if mode=='repeatable_read':
   need(worker.returncode!=0 and '40001' in err,'Stale RR snapshot did not fail serialization')
   need(sql(f"SELECT count(*) FROM ai_disposition_reviews WHERE id='{r2}'")=='0','Failed source insert survived serialization rollback')
   sql(ins(r2,m2,v2))
  else:need(worker.returncode==0,err)
  expected=1 if mode=='rollback' else 2
  need(sql(f"SELECT revision FROM inbox_t2_policy.versions WHERE org_id='{o}' AND namespace='property_reviews' AND entity_key=jsonb_build_array('{p1}'::uuid)::text")==str(expected),'Persistent shared revision lost/retained wrong increment')
  need(sql(f"SELECT count(*) FROM ai_disposition_reviews WHERE org_id='{o}'")==str(expected),'Source/counter atomicity lost')
  checks.append({'name':{'commit':'independent review inserts serialize shared property dependency and commit two increments','rollback':'rolled-back first review allocation disappears; waiting writer commits exactly one revision','repeatable_read':'stale REPEATABLE READ writer fails40001 with no source row; whole-transaction retry preserves one logical insert and two revisions'}[mode],'passed':True})
 finally:stop(worker);stop(holder)
evidence={'at':sql('SELECT statement_timestamp()::text'),'checks':checks,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Observed independent-session lock waits on shared dependency path, not universal deadlock freedom','Whole transaction retry tested for this owned SQL insertion; application/provider retry contract still incomplete']}
(P/'concurrency-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
