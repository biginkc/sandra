#!/usr/bin/env python3
if not __debug__:raise SystemExit('Refusing optimized Python before fixture access')
import argparse,hashlib,json,select,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
p=argparse.ArgumentParser();p.add_argument('--run-owned-fixture',action='store_true');p.add_argument('--continue-installed',action='store_true');a=p.parse_args()
if not a.run_owned_fixture:raise SystemExit('Explicit fixture grant required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def need(ok,msg):
 if ok is not True:raise RuntimeError(msg)
def sql(s,check=True):
 r=subprocess.run(CMD,input="SET statement_timeout='20s';SET lock_timeout='2s';"+s,text=True,capture_output=True,timeout=30)
 if check and r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip() if check else r
def uid():return str(uuid.uuid4())
def lit(v):return 'NULL' if v is None else "'"+str(v).replace("'","''")+"'"
def stop(p):
 if p is None:return
 if p.poll() is None:
  p.terminate()
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
 for f in [p.stdin,p.stdout,p.stderr]:
  if f:f.close()
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0]);validate_cron(sql('SHOW cron.launch_active_jobs;'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity;')=='sandra-inbox-projection-t2-owned-synthetic','Wrong marker')
old=(P/'setup-before-rr.sql').read_text();new=(P/'setup.sql').read_text()
def helper(source):return source[source.index('CREATE FUNCTION inbox_t2_message_capture.sender_id'):source.index('CREATE FUNCTION inbox_t2_message_capture.capture()')]
expected=helper(new if a.continue_installed else old).split('AS $$',1)[1].rsplit('$$;',1)[0]
need(sql("SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_message_capture.sender_id(uuid,text)'::regprocedure;").strip()==expected.strip(),'Expected original helper before bounded correction')
if not a.continue_installed:sql("BEGIN;"+helper(new).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)+"COMMIT;")
org=uid();raw='repeatable-read-'+uid();a,b=uid(),uid();app='registry-rr-'+uid()
sql(f"INSERT INTO organizations(id,name) VALUES('{org}','RR registry {org}');INSERT INTO inbox_t2_message_capture.sender_buckets VALUES('{org}',md5({lit(raw)}));")
def insert(mid):return f"INSERT INTO messages(id,org_id,channel,direction,status,from_address,body) VALUES('{mid}','{org}','sms','inbound','received',{lit(raw)},'RR synthetic');"
holder=waiter=None
try:
 holder=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 holder.stdin.write("SET statement_timeout='10s';SET idle_in_transaction_session_timeout='15s';BEGIN ISOLATION LEVEL REPEATABLE READ;"+insert(a)+"\n\\echo ready\n");holder.stdin.flush()
 ready,_,_=select.select([holder.stdout],[],[],10);need(bool(ready) and holder.stdout.readline().strip()=='ready','Holder write-barrier not ready')
 waiter=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 waiter.stdin.write("SET statement_timeout='10s';SET application_name="+lit(app)+";BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT count(*) FROM inbox_t2_message_capture.sender_buckets WHERE org_id='"+org+"';"+insert(b)+"COMMIT;\n");waiter.stdin.close()
 deadline=time.monotonic()+5;blocked=False
 while time.monotonic()<deadline:
  if sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name={lit(app)} AND cardinality(pg_blocking_pids(pid))>0);")=='t':blocked=True;break
  time.sleep(.02)
 need(blocked,'Second RR writer did not wait on existing bucket')
 holder.stdin.write('COMMIT;\n\\q\n');holder.stdin.flush();holder.wait(timeout=5);need(holder.returncode==0,'First RR writer failed')
 waiter.wait(timeout=5);error=waiter.stderr.read();need(waiter.returncode!=0 and 'ERROR:  40001:' in error,'Expected serialization rejection, not duplicate registry allocation')
 need(sql(f"SELECT count(*) FROM messages WHERE id='{b}';")=='0','Aborted second writer leaked message')
 need(sql(f"SELECT count(*) FROM inbox_t2_message_capture.sender_groups WHERE org_id='{org}' AND raw_sender={lit(raw)};")=='1','Duplicate group after stale snapshot')
 sql('BEGIN ISOLATION LEVEL REPEATABLE READ;'+insert(b)+'COMMIT;')
 need(sql(f"SELECT count(*) FROM inbox_t2_message_capture.sender_groups WHERE org_id='{org}' AND raw_sender={lit(raw)};")=='1','Whole-transaction retry duplicated group')
 need(sql(f"SELECT generation FROM inbox_t2_message_capture.dirty WHERE org_id='{org}' AND target_kind='unknown_sender';")=='2','Retry lost or duplicated dirty generation')
 result={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checks':[{'name':'existing bucket concurrent RR miss waits then fails40001 without source or registry leak','passed':True},{'name':'whole RR transaction retry uses one retained identity and exactly two dirty generations','passed':True}],'org':org,'sqlstate':'40001','setup_sha256':hashlib.sha256(new.encode()).hexdigest(),'limits':['Final source verified before existing-bucket RR proof; earlier correction and19+5 receipts preserved','Existing bucket deliberately preseeded without raw group to exercise retained/colliding-bucket miss','Enabled writers still need whole-transaction retry; no automatic retry was added to production']}
 (P/'repeatable-read-evidence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
finally:stop(holder);stop(waiter)
