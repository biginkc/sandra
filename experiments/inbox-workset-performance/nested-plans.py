#!/usr/bin/env python3
import argparse,json,re,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container
ap=argparse.ArgumentParser();ap.add_argument('--run-owned-fixture',action='store_true');ap.add_argument('--variant',choices=['baseline','typed'],required=True);ap.add_argument('--size',type=int,default=120000);args=ap.parse_args()
if not args.run_owned_fixture:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db';validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
corpus=next(c for c in json.loads((P/'corpus.json').read_text()) if c['size']==args.size);o=corpus['org'];u=corpus['user'];sid=corpus['session'];claims=json.dumps({'sub':u,'role':'authenticated','session_id':sid,'exp':4102444800})
queries={'counts':f"SELECT inbox_t2_bridge.counts_baseline('{o}','{{\"view\":\"all\"}}')",'page':f"SELECT * FROM inbox_t2_bridge.matching('{o}','{u}',inbox_t2_bridge.normalize_filter('{{\"view\":\"all\"}}')) ORDER BY latest_at DESC NULLS LAST,target_kind,target_id LIMIT 100"}
if args.variant=='typed':queries={'counts':f"SELECT inbox_t2_bridge.counts_typed('{o}','{u}',inbox_t2_bridge.normalize_filter('{{\"view\":\"all\"}}'))",'page':f"SELECT * FROM inbox_t2_bridge.page('{o}','{u}',inbox_t2_bridge.normalize_filter('{{\"view\":\"all\"}}'),NULL,NULL,NULL,false,100)"}
for name,query in queries.items():
 q=f"""BEGIN READ ONLY;SET LOCAL statement_timeout='60s';LOAD 'auto_explain';SET LOCAL auto_explain.log_min_duration=0;SET LOCAL auto_explain.log_nested_statements=on;SET LOCAL auto_explain.log_analyze=on;SET LOCAL auto_explain.log_buffers=on;SET LOCAL auto_explain.log_timing=off;SET LOCAL auto_explain.log_format=json;SET LOCAL auto_explain.log_parameter_max_length=0;SET LOCAL auto_explain.log_level=notice;SET LOCAL client_min_messages=notice;SET LOCAL ROLE postgres;SET LOCAL request.jwt.claims='{claims}';{query};ROLLBACK;"""
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True,timeout=70)
 if r.returncode:raise RuntimeError(r.stderr)
 plans=[]
 for m in re.finditer(r'plan:\s*(?=\{)',r.stderr):plans.append(json.JSONDecoder().raw_decode(r.stderr[m.end():])[0])
 if not plans:raise RuntimeError('No nested plans captured')
 (P/(args.variant+'-'+str(args.size)+'-'+name+'-nested.json')).write_text(json.dumps(plans,indent=2)+'\n')
 print(f'{args.variant} {name}: {len(plans)} actual nested plans')
