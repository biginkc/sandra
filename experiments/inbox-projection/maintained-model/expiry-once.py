#!/usr/bin/env python3
if not __debug__: raise SystemExit('Optimized Python refused before fixture access')
import argparse,hashlib,json,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
parser=argparse.ArgumentParser();parser.add_argument('--run-owned-fixture',action='store_true');parser.add_argument('--batch',type=int,default=10,choices=range(1,101));args=parser.parse_args()
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

# Read only bounded index candidates without locking projection rows first.
# wake_expiry rechecks revision/deadline using dirty -> projection lock order.
candidates=json.loads(sql(f"SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]') FROM (SELECT org_id,target_kind,target_id,revision FROM inbox_t2_maintained.rows WHERE next_expiry<statement_timestamp() ORDER BY next_expiry,org_id,target_kind,target_id LIMIT {args.batch}) p"))
results=[]
for candidate in candidates:
 try:
  o=candidate['org_id'];k=candidate['target_kind'];t=candidate['target_id'];r=candidate['revision']
  woke=sql(f"SELECT inbox_t2_maintained.wake_expiry('{o}',{lit(k)},'{t}',{int(r)},statement_timestamp())")
  results.append({'target_id':t,'status':'enqueued' if woke=='t' else 'superseded'})
 except (RuntimeError,subprocess.TimeoutExpired):
  # A lost reply can mean commit succeeded. Never clear the schedule client-side.
  results.append({'target_id':candidate['target_id'],'status':'unknown_result_retry_discovery'})
print(json.dumps({'discovered':len(candidates),'results':results},indent=2))
if any(r['status']=='unknown_result_retry_discovery' for r in results):raise SystemExit(1)
