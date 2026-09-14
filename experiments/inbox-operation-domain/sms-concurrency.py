#!/usr/bin/env python3
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,queue,runpy,subprocess,sys,threading,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit fixture required')
sys.argv=[str(P/'run-sms.py'),'--run-owned-fixture','--continue-installed']
f=runpy.run_path(str(P/'run-sms.py'))
for key in ['sql','need','uid','lit','D','N','o','u','a','c','p','conv','op','item','req','sibling']:globals()[key]=f[key]
CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
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
checks=[];source_op=op;operations=[]
def newstep():
 global op
 op=uid();operations.append(op);sid=uid();ordinal=0
 sql(f"INSERT INTO inbox_operations.operations(org_id,id,requester_id,idempotency_key,input_hash,preparation_id,definition) SELECT org_id,'{op}',requester_id,'{uid()}',input_hash,preparation_id,definition FROM inbox_operations.operations WHERE org_id='{o}' AND id='{source_op}';INSERT INTO inbox_operations.items SELECT org_id,'{op}',id,target_kind,target_id,resolution,exclusion_code FROM inbox_operations.items WHERE org_id='{o}' AND operation_id='{source_op}'")
 vector=json.loads(sql(f"SELECT inbox_t2_policy.snapshot('{o}',{lit(json.dumps(req))})"))
 scope=json.loads(sql(f"SELECT jsonb_build_object('contact_id','{c}','revision',(SELECT revision::text FROM inbox_operation_domain.sms_scopes WHERE org_id='{o}' AND contact_id='{c}'),'property_ids',(SELECT jsonb_agg(id ORDER BY id) FROM properties WHERE org_id='{o}' AND homeowner_contact_id='{c}'),'enrollment_ids',coalesce((SELECT jsonb_agg(e.id ORDER BY e.id) FROM sequence_enrollments e JOIN properties p ON p.id=e.property_id AND p.org_id=e.org_id WHERE e.org_id='{o}' AND p.homeowner_contact_id='{c}' AND e.status='active'),'[]'::jsonb))"))
 deps={'policy':vector,'targets':[{'conversation_id':conv,'revision':sql(f"SELECT revision FROM inbox_operation_domain.target_versions WHERE org_id='{o}' AND conversation_id='{conv}'")}],'sms_scope':scope}
 sql(f"INSERT INTO inbox_operations.steps(org_id,operation_id,id,effect_key,ordinal,action,payload,dependencies) VALUES('{o}','{op}','{sid}','property:{p}',{ordinal},'outcome','{{\"property_id\":\"{p}\",\"value\":\"opted_out\"}}',{lit(json.dumps(deps))});INSERT INTO inbox_operations.item_steps VALUES('{o}','{op}','{item}','{sid}')")
 generation=sql(f"SELECT inbox_operations.claim_step('{o}','{op}','{sid}')")
 return sid,f"SELECT inbox_operation_domain.apply_property_step('{o}','{op}','{sid}',{generation});"
def enrollment():
 sequence,eid=uid(),uid()
 sql(f"INSERT INTO sequences(id,org_id,name) VALUES('{sequence}','{o}','Concurrency {sequence}')")
 return eid,f"INSERT INTO sequence_enrollments(id,org_id,sequence_id,property_id,status,next_run_at) VALUES('{eid}','{o}','{sequence}','{p}','active',clock_timestamp());"
def receipts(s):return sql(f"SELECT count(*) FROM inbox_operations.receipts WHERE operation_id='{op}' AND step_id='{s}'")
try:
 sid,apply=newstep();eid,insert=enrollment();writer=Session();writer.barrier('BEGIN;'+insert)
 worker=Session();worker.close(apply);blocked(worker,writer)
 need(receipts(sid)=='0','Waiting operation falsely completed')
 writer.close('COMMIT;');need(writer.result()[0]==0,'Writer failed')
 rc,out,err=worker.result();need(rc!=0 and 'SMS scope changed or unseeded' in err,'Concurrent enrollment accepted: '+err)
 need(receipts(sid)=='0' and sql(f"SELECT status FROM sequence_enrollments WHERE id='{eid}'")=='active','Conflict changed enrollment or wrote receipt')
 checks.append('committed concurrent enrollment insert invalidates prepared scope after actual wait')
 sid,apply=newstep();holder=Session();holder.barrier('BEGIN;'+apply)
 eid2,insert=enrollment();writer=Session();writer.close('BEGIN;'+insert+'ROLLBACK;');blocked(writer,holder)
 need(receipts(sid)=='0','Uncommitted effect exposed receipt')
 holder.close('COMMIT;');need(holder.result()[0]==0,'Effect holder failed')
 rc,out,err=writer.result();need(rc==0,err)
 need(receipts(sid)=='1' and sql(f"SELECT status FROM sequence_enrollments WHERE id='{eid}'")=='opted_out','Serialized SMS stop missing')
 need(sql(f"SELECT count(*) FROM sequence_enrollments WHERE id='{eid2}'")=='0','Rolled-back later insert persisted')
 checks.append('canonical property guard makes new enrollment wait for effect transaction commit')
 sid,apply=newstep();other=uid();sql(f"INSERT INTO contacts(id,org_id,first_name) VALUES('{other}','{o}','Reparent target')")
 writer=Session();writer.barrier(f"BEGIN;UPDATE properties SET homeowner_contact_id='{other}' WHERE id='{sibling}';")
 worker=Session();worker.close(apply);blocked(worker,writer)
 writer.close('COMMIT;');need(writer.result()[0]==0,'Reparent writer failed')
 rc,out,err=worker.result();need(rc!=0 and 'SMS scope changed or unseeded' in err,'Concurrent sibling reparent accepted: '+err)
 need(receipts(sid)=='0','Reparent conflict completed operation')
 checks.append('sibling homeowner reparent invalidates prepared scope under actual contention')
 (P/'sms-concurrency-evidence.json').write_text(json.dumps({'checks':[{'name':name,'passed':True} for name in checks],'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'source_hashes':{name:hashlib.sha256((P/name).read_bytes()).hexdigest() for name in ['restrictive-scope.sql','restrictive-effect.sql','restrictive-apply.sql']},'fixture_operation_ids':operations},indent=2)+'\n')
 print('Passed '+str(len(checks))+' actual SMS concurrency groups')
finally:
 for process in processes:process.stop()
