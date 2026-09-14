#!/usr/bin/env python3
import hashlib,json,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db';validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input="SET statement_timeout='60s';"+q,text=True,capture_output=True,timeout=70)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong fixture')
if (P/'search-scale-evidence.json').exists():raise RuntimeError('Already measured; preserve receipt')
results=[]
for corpus in json.loads((P/'corpus.json').read_text()):
 o=corpus['org'];u=corpus['user'];c=hashlib.md5((o+'11111').encode()).hexdigest();c=str(uuid.UUID(c));ct=str(uuid.uuid4())
 sql(f"INSERT INTO contacts(id,org_id,first_name) VALUES('{ct}','{o}','Scale Needle Name');INSERT INTO messages(id,org_id,conversation_id,contact_id,channel,direction,status,body,created_at) VALUES('{uuid.uuid4()}','{o}','{c}','{ct}','sms','inbound','received','quartzprefix historical needle',clock_timestamp()-interval '500 days');UPDATE inbox_t2_maintained.rows SET summary=summary||jsonb_build_object('contact_id','{ct}'),revision=revision+1 WHERE org_id='{o}' AND target_id='{c}'")
 for search in ['Needle Name','quartzpref']:
  nf=f"inbox_t2_bridge.normalize_filter('{{\"view\":\"all\",\"hide_noise\":false,\"search\":\"{search}\"}}')"
  for variant in ['baseline','typed']:
   q=f"SELECT * FROM inbox_t2_bridge.matching('{o}','{u}',{nf}) ORDER BY latest_at DESC NULLS LAST,target_kind,target_id LIMIT 100" if variant=='baseline' else f"SELECT * FROM inbox_t2_bridge.page('{o}','{u}',{nf},NULL,NULL,NULL,false,100)"
   actual=json.loads(sql('SELECT coalesce(jsonb_agg(target_id),\'[]\') FROM ('+q+')q'))
   if actual!=[c]:raise RuntimeError('Search did not find exact deep corpus target')
   times=[]
   for _ in range(5):times.append(json.loads(sql('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+q))[0]['Execution Time'])
   results.append({'size':corpus['size'],'search':search,'variant':variant,'samples':times,'max_ms':max(times),'exact_target_match':True})
   print(results[-1],flush=True)
(P/'search-scale-evidence.json').write_text(json.dumps({'results':results,'limitation':'Five exploratory samples, one canonical history match beyond firstpage per corpus'},indent=2)+'\n')
