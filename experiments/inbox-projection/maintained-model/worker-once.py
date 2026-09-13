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

results=[]
# A claimed target starts immediately; do not let later targets' leases age
# while earlier canonical computations run. The invocation still has a hard cap.
for _ in range(args.batch):
 claims=json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]') FROM inbox_t2_maintained.claim_work(1,30) q"))
 if not claims:break
 q=claims[0]
 o=q['org_id'];k=q['target_kind'];t=q['target_id']
 try:
  raw=sql(f"SELECT inbox_t2_maintained.snapshot('{o}',{lit(k)},'{t}',statement_timestamp())")
  if not raw:
   results.append({'target_id':t,'status':'missing_snapshot_lease_retained'});continue
  candidate=json.loads(raw)
  result=sql(f"SELECT inbox_t2_maintained.finish_work('{q['claim_token']}',{lit(json.dumps(candidate))}::jsonb)")
  results.append({'target_id':t,'status':result})
 except (RuntimeError,subprocess.TimeoutExpired,json.JSONDecodeError):
  # Leave failed work claimed until expiry; never acknowledge unknown completion.
  results.append({'target_id':t,'status':'error_lease_retained'})
applied=sum(r['status'] in ('applied','already_applied') for r in results)
retry=sum(r['status'] in ('stale_claim','projection_conflict') for r in results)
rejected=len(results)-applied-retry
print(json.dumps({'claimed':len(results),'applied':applied,'retry':retry,'rejected':rejected,'results':results},indent=2))
if rejected:raise SystemExit(1)
