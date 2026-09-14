#!/usr/bin/env python3
"""Install candidate and backfill only owned corpus rows with source-row fencing."""
import json,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input="SET statement_timeout='30s';SET lock_timeout='2s';"+q,text=True,capture_output=True,timeout=40)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong fixture')
results=[]
for c in json.loads((P.parent/'inbox-workset-performance/corpus.json').read_text()):
 prefix="SET request.jwt.claims='"+json.dumps({'sub':c['user'],'session_id':c['session'],'role':'authenticated','exp':4102444800})+"';"
 q=f"SELECT public.inbox_outcome_counts_v1('{c['org']}','{{\"view\":\"all\"}}')"
 value=json.loads(sql(prefix+q))
 if value['known_total']!=c['expected_counts']['all'] or value['unknown_count']!=c['expected_counts']['unknown'] or value['outcome_counts']['no_outcome']!=value['known_total']:raise RuntimeError('Scale independent counts mismatch')
 times=[];plans=[]
 for _ in range(10):
  plan=json.loads(sql(prefix+'EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+q))[0];times.append(plan['Execution Time']);plans.append(plan)
 results.append({'size':c['size'],'p50_ms':sorted(times)[4],'p95_ms':sorted(times)[9],'times_ms':times,'plans':plans})
(P/'scale-evidence.json').write_text(json.dumps({'results':results,'limitation':'Synthetic512MiB1CPU;10 samples p95=max, not production acceptance'},indent=2)+'\n')
print([(r['size'],r['p95_ms']) for r in results])
