#!/usr/bin/env python3
"""Owned T2 real-session read acknowledgment contention. No schema installation."""
if not __debug__: raise SystemExit('Optimized Python refused')
import hashlib,json,queue,re,subprocess,sys,threading,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def need(value,label):
 if not value:raise RuntimeError(label)
def sql(q):
 r=subprocess.run(CMD,input="SET statement_timeout='15s';SET lock_timeout='3s';"+q,text=True,capture_output=True,timeout=25)
 need(r.returncode==0,r.stderr);return r.stdout.strip()
def uid():return str(uuid.uuid4())
def lit(s):return "'"+str(s).replace("'","''")+"'"
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture')
for name,args,body in re.findall(r'CREATE FUNCTION inbox_t2_read\.(\w+)\((.*?)\) RETURNS jsonb.*?AS \$\$(.*?)\$\$;', (P/'setup.sql').read_text(),re.S):
 signature=','.join(arg.strip().split()[-1] for arg in args.split(','))
 need(sql(f"SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_read.{name}({signature})'::regprocedure")==body.strip(),'Installed source differs: '+name)
processes=[]
class Session:
 def __init__(self,prefix=''):
  self.name='inbox-read-'+uid();self.lines=[];self.out=queue.Queue()
  self.p=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1);processes.append(self)
  def collect():
   for line in self.p.stdout:
    self.lines.append(line.strip());self.out.put(line.strip())
  self.reader=threading.Thread(target=collect,daemon=True);self.reader.start()
  self.send(f"SET application_name='{self.name}';SET statement_timeout='15s';SET idle_in_transaction_session_timeout='20s';"+prefix)
 def send(self,q):self.p.stdin.write(q+'\n');self.p.stdin.flush()
 def barrier(self,q):
  tag='ready'+uuid.uuid4().hex;self.send(q+'\n\\echo '+tag)
  deadline=time.monotonic()+10
  while time.monotonic()<deadline:
   try:line=self.out.get(timeout=max(.01,deadline-time.monotonic()))
   except queue.Empty:break
   if line==tag:return
  raise RuntimeError('Session barrier failed '+self.name)
 def close(self,q=''):
  self.send(q+'\n\\q');self.p.stdin.close()
 def result(self):
  self.p.wait(timeout=20);self.reader.join(timeout=2);return self.p.returncode,'\n'.join(self.lines),self.p.stderr.read()
 def stop(self):
  if self.p.poll() is None:
   self.p.terminate()
   try:self.p.wait(timeout=5)
   except subprocess.TimeoutExpired:self.p.kill();self.p.wait(timeout=5)
 def pid(self):return sql(f"SELECT pid FROM pg_stat_activity WHERE application_name='{self.name}'")
def blocked(waiter,holder):
 deadline=time.monotonic()+6
 while time.monotonic()<deadline:
  if sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity h ON h.application_name='{holder.name}' WHERE w.application_name='{waiter.name}' AND h.pid=ANY(pg_blocking_pids(w.pid)))")=='t':return
  if waiter.p.poll() is not None:raise RuntimeError('Waiter exited before expected lock')
  time.sleep(.025)
 raise RuntimeError('Expected actual lock wait absent')
checks=[]
def fixture():
 o,u,owner,s,c,contact,p,m=[uid() for _ in range(8)]
 sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Read concurrency {o}');INSERT INTO auth.users(id) VALUES('{owner}'),('{u}');INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{owner}','{o}','owner','active'),('{u}','{o}','member','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{s}','{u}',clock_timestamp()+interval '1 hour');INSERT INTO contacts(id,org_id,first_name) VALUES('{contact}','{o}','Synthetic');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{p}','{o}','Read fixture {p}','MO','{contact}');INSERT INTO messages(id,org_id,conversation_id,property_id,contact_id,channel,direction,status,body) VALUES('{m}','{o}','{c}','{p}','{contact}','sms','inbound','received','Read contention');COMMIT;")
 claims=json.dumps({'sub':u,'role':'authenticated','session_id':s,'exp':4102444800})
 auth='SET request.jwt.claims='+lit(claims)+';SET ROLE authenticated;'
 detail=json.loads(sql(auth+f"SELECT inbox_t2_read.detail('{o}','{c}')"))
 return {'o':o,'c':c,'p':p,'m':m,'auth':auth,'b':detail['read_boundary']}
def ackq(f):return f"SELECT inbox_t2_read.acknowledge('{f['b']}',0);"
def unread(f):return sql(f"SELECT read_at IS NULL FROM messages WHERE id='{f['m']}'")=='t'
def receipts(f):return int(sql(f"SELECT count(*) FROM inbox_t2_read.receipts WHERE boundary_id='{f['b']}'"))
def receipt(out):return next(json.loads(line) for line in out.splitlines() if line.startswith('{'))
try:
 # A held candidate prevents acknowledgment completion; the same batch holds a
 # SHARE generation lock, so a reset must wait for it. Reset is rolled back.
 f=fixture();holder=Session();holder.barrier(f"BEGIN;DO $$ BEGIN PERFORM 1 FROM messages WHERE id='{f['m']}' FOR UPDATE;END $$;")
 worker=Session(f['auth']);worker.close(ackq(f));blocked(worker,holder)
 need(receipts(f)==0 and unread(f),'Locked candidate falsely completed')
 reset=Session();reset.close('BEGIN;UPDATE inbox_t2_capture_boundary.generation SET generation=gen_random_uuid() WHERE singleton IS TRUE;ROLLBACK;');blocked(reset,worker)
 holder.close('COMMIT;');need(holder.result()[0]==0,'Candidate holder failed')
 rc,out,err=worker.result();need(rc==0,err);r=receipt(out);need(r['changed']==1 and r['completed'],'Released candidate not acknowledged')
 need(reset.result()[0]==0,'Generation reset did not finish after release')
 checks.append('held message prevents false completion; generation reset actually waits for acknowledgment FOR SHARE')
 # A later backdated arrival is above the captured boundary despite timestamp.
 f=fixture();late=uid();writer=Session();writer.close(f"INSERT INTO messages(id,org_id,conversation_id,channel,direction,body,created_at) VALUES('{late}','{f['o']}','{f['c']}','sms','inbound','Late backdated',clock_timestamp()-interval '1 year');")
 need(writer.result()[0]==0,'Late source insert failed');r=json.loads(sql(f['auth']+ackq(f)))
 need(r['changed']==1 and r['completed'] and sql(f"SELECT read_at IS NULL FROM messages WHERE id='{late}'")=='t','Late arrival swept into old read')
 checks.append('separate writer backdated arrival remains unread under old boundary')
 # Move out and back while holding the source transaction. The waiting reader
 # must use the re-entered revision, not its old candidate membership.
 f=fixture();mover=Session();mover.barrier(f"BEGIN;UPDATE messages SET conversation_id='{uid()}' WHERE id='{f['m']}';UPDATE messages SET conversation_id='{f['c']}' WHERE id='{f['m']}';")
 worker=Session(f['auth']);worker.close(ackq(f));blocked(worker,mover)
 mover.close('COMMIT;');need(mover.result()[0]==0,'Identity mover failed')
 rc,out,err=worker.result();need(rc==0,err);r=receipt(out)
 need(r['changed']==0 and r['completed'] and unread(f),'Moved-out/back identity incorrectly acknowledged')
 checks.append('actual waiting acknowledgment excludes source moved out and back with fresh revision')
 # DNC guard is checked after waiting on the canonical property lock.
 f=fixture();locker=Session();locker.barrier(f"BEGIN;UPDATE properties SET outreach_dispo='dnc' WHERE id='{f['p']}';")
 worker=Session(f['auth']);worker.close(ackq(f));blocked(worker,locker)
 locker.close('COMMIT;');need(locker.result()[0]==0,'DNC writer failed')
 rc,out,err=worker.result();need(rc!=0 and 'DNC_LOCKED' in err,err)
 need(unread(f) and receipts(f)==0,'DNC failure leaked read/receipt')
 checks.append('concurrent committed DNC locks deny acknowledgment without a read or receipt')
 # Enter before the execution deadline, hold a real candidate lock until the
 # database clock passes it, then require transaction rollback after the wait.
 f=fixture();sql(f"UPDATE inbox_t2_read.boundaries SET execution_deadline=clock_timestamp()+interval '2 seconds' WHERE id='{f['b']}'")
 holder=Session();holder.barrier(f"BEGIN;DO $$ BEGIN PERFORM 1 FROM messages WHERE id='{f['m']}' FOR UPDATE;END $$;")
 worker=Session(f['auth']);worker.close(ackq(f));blocked(worker,holder)
 deadline=time.monotonic()+6
 while sql(f"SELECT clock_timestamp()>execution_deadline FROM inbox_t2_read.boundaries WHERE id='{f['b']}'")!='t':
  need(time.monotonic()<deadline,'Database execution deadline did not elapse');time.sleep(.025)
 holder.close('COMMIT;');need(holder.result()[0]==0,'Deadline holder failed')
 rc,out,err=worker.result();need(rc!=0 and 'INBOX_READ_EXPIRED' in err,err)
 need(unread(f) and receipts(f)==0,'Expired in-flight acknowledgment leaked read or receipt')
 need(sql(f"SELECT next_batch=0 AND NOT completed FROM inbox_t2_read.boundaries WHERE id='{f['b']}'")=='t','Expired batch advanced boundary')
 checks.append('execution deadline elapses during observed source wait; read, receipt and boundary advancement roll back')
 # Deliberately create the real legacy lock inversion: source message first
 # versus acknowledgment property first. PostgreSQL may select either victim.
 f=fixture();writer=Session();writer.barrier(f"BEGIN;DO $$ BEGIN PERFORM 1 FROM messages WHERE id='{f['m']}' FOR UPDATE;END $$;")
 worker=Session(f['auth']);worker.close(ackq(f));blocked(worker,writer)
 writer.close(f"UPDATE properties SET updated_at=clock_timestamp() WHERE id='{f['p']}';COMMIT;")
 wr,wout,werr=writer.result();ar,aout,aerr=worker.result()
 need((wr!=0 and '40P01' in werr) or (ar!=0 and '40P01' in aerr),'Actual deadlock absent: '+werr+aerr)
 if ar!=0:need(receipts(f)==0 and unread(f),'Aborted read leaked effect/receipt')
 else:need(receipt(aout)['changed']==1 and receipts(f)==1,'Surviving read inconsistent')
 retried=json.loads(sql(f['auth']+ackq(f)));need(retried['changed']==1 and retried['completed'] and receipts(f)==1 and not unread(f),'Same boundary/batch retry did not converge')
 victim='acknowledgment' if ar!=0 else 'legacy_writer'
 checks.append(('aborted acknowledgment rolls back read/receipt; ' if ar!=0 else 'legacy writer is deadlock victim and acknowledgment commits; ')+'same boundary/batch retry converges to one receipt')
 evidence={'deadlock_victim':victim,'aborted_acknowledgment_rollback_proved':ar!=0,'at':sql('SELECT clock_timestamp()::text'),'checks':checks,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Trusted SQL claims, no JWT transport or browser render proof','Deadlock victim selection may vary; no general deadlock-freedom claim','Synthetic owned rows retained; generation-reset transaction rolled back']}
 (P/'concurrency-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
finally:
 for session in processes:session.stop()
