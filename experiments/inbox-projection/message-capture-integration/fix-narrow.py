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
old=(P/'setup-before-narrow.sql').read_text();new=(P/'setup.sql').read_text()
def definition(s):return s[s.index('CREATE FUNCTION inbox_t2_message_capture.capture()'):s.index('CREATE TRIGGER zzzzz_inbox_t2_message_direct')]
expected=definition(old).split('AS $$',1)[1].rsplit('$$;',1)[0]
need(sql("SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_message_capture.capture()'::regprocedure;").strip()==expected.strip(),'Unexpected capture before narrow correction')
sql('BEGIN;'+definition(new).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)+'COMMIT;')
print('Applied narrow OLD/NEW identity fields; required direct field comparisons preserved')
