#!/usr/bin/env python3
"""Actual nested RPC plans. Exclusive fixture window required; fixture grants roll back."""
import argparse,hashlib,json,re,subprocess,sys,time
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N='sandra-inbox-projection-t2-db'
CMD=D+['exec','-i',N,'psql','-XqAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1']
def need(ok,msg):
 if ok is not True:raise RuntimeError(msg)
def sql(s):
 r=subprocess.run(CMD,input=s,text=True,capture_output=True,timeout=60)
 if r.returncode:raise RuntimeError(r.stderr)
 return r
parser=argparse.ArgumentParser();parser.add_argument('--run-owned-fixture',action='store_true');parser.add_argument('--candidate-version',choices=['v1','v2'],default='v1');args=parser.parse_args()
FUNCTION='detail_v2' if args.candidate_version=='v2' else 'detail'
SETUP=P/('setup-v2.sql' if args.candidate_version=='v2' else 'setup.sql')
need(args.run_owned_fixture and not sys.flags.optimize,'Explicit owned fixture grant required; no optimized Python')
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=10))[0]);validate_cron(sql('SHOW cron.launch_active_jobs;').stdout.strip())
need(sql('SELECT marker FROM inbox_t2_fixture.identity;').stdout.strip()=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture')
receipt=json.loads((P/'evidence.json').read_text());noise=json.loads((P.parent/'index-proof/noise-evidence.json').read_text());org=noise['target']['org'];conv=noise['target']['conv']
source=SETUP.read_text();expected_body=re.search(r'CREATE FUNCTION.*?AS \$\$(.*?)\$\$;',source,re.S).group(1).strip()
installed=json.loads(sql(f"SELECT jsonb_build_object('body',prosrc,'owner',pg_get_userbyid(proowner),'stable',provolatile='s','definer',prosecdef) FROM pg_proc WHERE oid='inbox_t2_authenticated_detail.{FUNCTION}(uuid,uuid,timestamptz,uuid)'::regprocedure;").stdout)
need(installed['body'].strip()==expected_body and installed['owner']=='postgres' and installed['stable'] is True and installed['definer'] is True,'Installed RPC does not match source under test')
user=sql(f"SELECT user_id FROM public.memberships WHERE org_id='{receipt['org']}' AND role='owner' ORDER BY user_id LIMIT 1;").stdout.strip();need(bool(re.fullmatch('[0-9a-f-]{36}',user)),'No existing synthetic keeper identity')
cursor=json.loads(sql(f"SELECT jsonb_build_object('id',id,'at',created_at::text) FROM public.messages WHERE org_id='{org}' AND conversation_id='{conv}' AND channel='sms' ORDER BY created_at DESC,id DESC OFFSET 89999 LIMIT 1;").stdout)
def scans(plan):
 result=[]
 def visit(n):
  if 'Scan' in n.get('Node Type',''):result.append({k:n.get(k) for k in ['Node Type','Index Name','Actual Rows','Actual Loops','Rows Removed by Filter','Rows Removed by Index Recheck','Index Cond','Filter','Heap Fetches','Shared Hit Blocks','Shared Read Blocks']})
  for c in n.get('Plans',[]):visit(c)
 visit(plan);return result
out=P/('rpc-plans-'+time.strftime('%Y%m%dT%H%M%S',time.gmtime()));out.mkdir()
summary={}
try:
 for mode in ['force_custom_plan','force_generic_plan']:
  for page in ['first','deep']:
   name=mode+'-'+page
   boundary='' if page=='first' else f"AND (created_at,id)<('{cursor['at']}'::timestamptz,'{cursor['id']}'::uuid)"
   expected=json.loads(sql(f"SELECT jsonb_agg(id ORDER BY created_at DESC,id DESC) FROM (SELECT id,created_at FROM public.messages WHERE org_id='{org}' AND conversation_id='{conv}' AND channel='sms' {boundary} ORDER BY created_at DESC,id DESC LIMIT 50) s;").stdout)
   values="NULL,NULL" if page=='first' else f"'{cursor['at']}'::timestamptz,'{cursor['id']}'::uuid"
   claims=json.dumps({'sub':user,'role':'authenticated'})
   # Superuser LOAD and settings are confined to this session. Fixture membership
   # is inserted under canonical postgres ownership, then rolled back on exit.
   q=f"""BEGIN;SET LOCAL statement_timeout='30s';SET LOCAL lock_timeout='2s';SET LOCAL ROLE postgres;
INSERT INTO public.memberships(user_id,org_id,role,access_status) VALUES('{user}','{org}','owner','active') ON CONFLICT(user_id,org_id) DO NOTHING;
RESET ROLE;LOAD 'auto_explain';SET LOCAL auto_explain.log_min_duration=0;SET LOCAL auto_explain.log_nested_statements=on;SET LOCAL auto_explain.log_analyze=on;SET LOCAL auto_explain.log_buffers=on;SET LOCAL auto_explain.log_timing=off;SET LOCAL auto_explain.log_format=json;SET LOCAL auto_explain.log_parameter_max_length=0;SET LOCAL auto_explain.log_level=notice;SET LOCAL client_min_messages=notice;SET LOCAL plan_cache_mode='{mode}';SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claims='{claims}';
PREPARE detail_plan(uuid,uuid,timestamptz,uuid) AS SELECT inbox_t2_authenticated_detail.{FUNCTION}($1,$2,$3,$4);
EXECUTE detail_plan('{org}','{conv}',{values});ROLLBACK;"""
   response=sql(q);(out/(name+'.stderr.txt')).write_text(response.stderr)
   actual=json.loads(response.stdout);need([x['id'] for x in actual['history']]==expected,'Exact ordered IDs differ: '+name)
   records=[]
   for match in re.finditer(r'plan:\s*(?=\{)',response.stderr):
    parsed,_=json.JSONDecoder().raw_decode(response.stderr[match.end():]);records.append(parsed)
   need(bool(records),'No nested auto_explain plans captured')
   (out/(name+'.json')).write_text(json.dumps(records,indent=2)+'\n')
   nested=[p for p in records if 'WITH head AS MATERIALIZED' in p.get('Query Text','')]
   need(len(nested)==1,'Missing or duplicate actual inner head/history plan')
   sn=scans(nested[0]['Plan']);key=[n for n in sn if n.get('Index Name')=='t2_proof_history_idx'];pk=[n for n in sn if n.get('Index Name')=='messages_pkey']
   bounded=len(key)==1 and key[0]['Actual Rows']==50 and (key[0].get('Rows Removed by Filter') or 0)==0 and len(pk)==1 and pk[0]['Actual Rows']==1 and pk[0]['Actual Loops']==50
   summary[name]={'exact_ids_match':True,'head':actual['head_revision'],'cursor':cursor if page=='deep' else None,'bounded_observed':bounded,'history_scans':sn,'inner_plan_count':len(records)}
 need(sql(f"SELECT count(*) FROM public.memberships WHERE user_id='{user}' AND org_id='{org}';").stdout.strip()=='0','Rollback left fixture membership behind')
 result={'status':'MEASURED','at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'setup_sha256':hashlib.sha256(source.encode()).hexdigest(),'probe_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'summary':summary,'limits':['Actual function nested plans under forced custom/generic; not driver automatic transition','Statement snapshot auth using synthetic trusted claims; no HTTP/JWT verification','Warmed isolated corpus, no timing percentile or production guarantee','Session LOAD and SET LOCAL only; temporary membership rolled back','Deep cursor chosen with OFFSET in test oracle only, not in candidate RPC']}
 (out/'evidence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
except Exception as e:
 (out/'failure.json').write_text(json.dumps({'error':str(e),'summary':summary},indent=2)+'\n');raise
