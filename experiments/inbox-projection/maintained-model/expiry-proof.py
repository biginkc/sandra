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

import concurrent.futures,time
checks=[]
def mark(name): checks.append({'name':name,'passed':True})
o,c,contact,m=[uid() for _ in range(4)]
# The actual canonical message will age out under the real database clock.
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Expiry worker {o}');INSERT INTO contacts(id,org_id,first_name) VALUES('{contact}','{o}','Synthetic');INSERT INTO messages(id,org_id,conversation_id,contact_id,channel,direction,status,body,created_at) VALUES('{m}','{o}','{c}','{contact}','sms','inbound','received','expiry scheduler fixture',statement_timestamp()-interval '2160 hours'+interval '8 seconds');COMMIT;")
claims=json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]') FROM inbox_t2_maintained.claim_work(100,30) q"))
q=next(x for x in claims if x['org_id']==o and x['target_id']==c)
candidate=json.loads(sql(f"SELECT inbox_t2_maintained.snapshot('{o}','known_conversation','{c}',statement_timestamp())"))
need(candidate['summary']['exists'] is True,'fixture aged out before initial publication')
need(sql(f"SELECT inbox_t2_maintained.finish_work('{q['claim_token']}',{lit(json.dumps(candidate))}::jsonb)")=='applied','initial publication')
def state():return json.loads(sql(f"SELECT to_jsonb(p)||jsonb_build_object('dirty_generation',d.generation) FROM inbox_t2_maintained.rows p JOIN inbox_t2_message_capture.dirty d USING(org_id,target_kind,target_id) WHERE p.org_id='{o}' AND p.target_id='{c}'"))
before=state();need(before['next_expiry'] is not None,'missing actual expiry')
# Bounded wait for real wall-clock deadline, never change the database clock.
delay=float(sql(f"SELECT greatest(0,extract(epoch FROM next_expiry-clock_timestamp())) FROM inbox_t2_maintained.rows WHERE org_id='{o}' AND target_id='{c}'"))
need(delay<=8,'unexpected expiry delay');time.sleep(delay+0.05)
def invoke(name):
 result=subprocess.run([sys.executable,str(P/name),'--run-owned-fixture','--batch','100'],capture_output=True,text=True,timeout=60)
 if result.returncode:raise RuntimeError(result.stderr+result.stdout)
 return json.loads(result.stdout)
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 receipts=list(pool.map(invoke,['expiry-once.py','expiry-once.py']))
after=state();need(after['dirty_generation']==before['dirty_generation']+1,'overlapping scheduler double generation')
need(after['next_expiry'] is None,'expiry schedule not cleared')
need(sql(f"SELECT count(*) FROM inbox_t2_maintained.queue WHERE org_id='{o}' AND target_id='{c}'")=='1','expiry not durably enqueued')
mark('two overlapping scheduler processes cross a real deadline and enqueue exactly one generation')
worker=invoke('worker-once.py');final=state()
need(final['summary']['exists'] is False and final['source_generation']==final['dirty_generation'],'actual worker did not publish expiry tombstone')
need(sql(f"SELECT count(*) FROM inbox_t2_maintained.queue WHERE org_id='{o}' AND target_id='{c}'")=='0','caught-up expiry work not removed')
mark('separate worker process consumes expiry work and publishes actual canonical tombstone')
again=invoke('expiry-once.py');need(state()==final,'repeat scheduler changed completed target')
mark('scheduler invocation after completion leaves the target unchanged')
receipt={'at':sql('SELECT statement_timestamp()::text'),'checks':checks,'scheduler_receipts':receipts,'worker_receipt':worker,'source_hashes':{name:hashlib.sha256((P/name).read_bytes()).hexdigest() for name in ['setup.sql','queue.sql','expiry-once.py','worker-once.py','expiry-proof.py']},'limits':['Owned synthetic canonical database only','Two real scheduler processes; not a process-death test or throughput benchmark','No installed continuous daemon, parent fanout, production deployment or provider action']}
(P/'expiry-evidence.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'passed':len(checks),'checks':checks},indent=2))
