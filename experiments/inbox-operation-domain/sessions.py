import queue,subprocess,threading,time,uuid
CMD=None
sql=None
def uid():return str(uuid.uuid4())
def configure(command,query):
 global CMD,sql
 CMD=command;sql=query
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
