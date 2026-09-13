#!/usr/bin/env python3
if not __debug__:
    raise SystemExit('Refusing optimized Python: proof assertions must remain enabled')
import json, subprocess, sys, time
from pathlib import Path
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent.parent/'fixture'))
from guards import validate_container,validate_cron
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N='sandra-inbox-projection-t2-db'
P=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
def sql(s):
 p=subprocess.run(P,input=s,text=True,capture_output=True,timeout=90)
 if p.returncode:raise RuntimeError(p.stderr)
 return p.stdout.strip()
def require(value,msg):
 if value is not True:raise RuntimeError(msg)
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0]);validate_cron(sql('SHOW cron.launch_active_jobs;'))
require(sql('SELECT marker FROM inbox_t2_fixture.identity;')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture')
noise=json.loads((HERE.parent/'noise-evidence.json').read_text());org,conv=noise['target']['org'],noise['target']['conv']
scope="org_id=$1 AND conversation_id=$2 AND channel='sms'"
cols='id,created_at::text AS created_at_raw,body,inbox_inbound_revision::text AS revision'
def query(shape,cursor,limit):
 where=scope+(" AND (created_at,id)<($3,$4)" if cursor else '')
 if shape=='direct':return f'SELECT {cols} FROM public.messages WHERE {where} ORDER BY created_at DESC,id DESC LIMIT {limit}'
 keys=f'SELECT id,created_at FROM public.messages WHERE {where} ORDER BY created_at DESC,id DESC LIMIT {limit}'
 if shape=='keys_materialized':return f'WITH page AS MATERIALIZED ({keys}) SELECT m.id,m.created_at::text AS created_at_raw,m.body,m.inbox_inbound_revision::text AS revision FROM page p JOIN public.messages m ON m.id=p.id AND m.org_id=$1 AND m.conversation_id=$2 AND m.channel=\'sms\' ORDER BY p.created_at DESC,p.id DESC'
 if shape=='keys_lateral':return f'WITH page AS MATERIALIZED ({keys}) SELECT m.id,m.created_at_raw,m.body,m.revision FROM page p CROSS JOIN LATERAL (SELECT {cols} FROM public.messages WHERE id=p.id AND {scope} LIMIT 1) m ORDER BY p.created_at DESC,p.id DESC'
 raise RuntimeError(shape)
def execute(shape,mode,cursor=None,limit=50,plan=False):
 types='uuid,uuid'+(',timestamptz,uuid' if cursor else '')
 values=f"'{org}','{conv}'"+(f",'{cursor[1]}','{cursor[0]}'" if cursor else '')
 prefix=f"BEGIN READ ONLY;SET LOCAL statement_timeout='30s';SET LOCAL lock_timeout='2s';SET LOCAL plan_cache_mode='{mode}';PREPARE h({types}) AS "+query(shape,cursor,limit)+';'
 result=sql(prefix+('EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) ' if plan else '')+f'EXECUTE h({values});ROLLBACK;')
 return json.loads(result)[0] if plan else [line.split('|') for line in result.splitlines()]
def nodes(plan):
 out=[]
 def visit(p):
  if 'Scan' in p['Node Type']:out.append({k:p.get(k) for k in ['Node Type','Index Name','Actual Rows','Actual Loops','Rows Removed by Filter','Heap Fetches','Shared Hit Blocks','Shared Read Blocks']})
  for child in p.get('Plans',[]):visit(child)
 visit(plan['Plan']);return out
expected=execute('direct','force_custom_plan',limit=74)
require([r[0] for r in expected[:50]]==noise['expected_ids'],'Fixture changed unexpectedly')
plans={};checks=[];summary={}
for shape in ['direct','keys_materialized','keys_lateral']:
 for mode in ['force_custom_plan','force_generic_plan']:
  name=shape+'/'+mode
  actual=execute(shape,mode);first=execute(shape,mode,limit=37);second=execute(shape,mode,cursor=first[-1],limit=37)
  require([r[0] for r in actual]==[r[0] for r in expected[:50]],'Latest IDs/order mismatch '+name)
  require([r[0] for r in first+second]==[r[0] for r in expected],'Cursor ID/order mismatch '+name)
  plans[name]={'first':[execute(shape,mode,plan=True) for _ in range(2)],'cursor':[execute(shape,mode,cursor=first[-1],limit=37,plan=True) for _ in range(2)]}
  summary[name]={kind:[{'ms':p['Execution Time'],'nodes':nodes(p)} for p in samples] for kind,samples in plans[name].items()}
  checks.append({'name':name+' exact50 and raw timestamp/UUID37+37 cursor','passed':True})
  if shape=='keys_materialized':
   for kind,samples in plans[name].items():
    limit=50 if kind=='first' else 37
    for sample in samples:
     scan_nodes=nodes(sample)
     key_scans=[n for n in scan_nodes if n['Index Name']=='t2_proof_history_idx']
     body_scans=[n for n in scan_nodes if n['Index Name']=='messages_pkey']
     require(len(key_scans)==1 and key_scans[0]['Actual Rows']==limit and key_scans[0]['Actual Loops']==1,'Expected limited scoped key scan')
     require(len(body_scans)==1 and body_scans[0]['Actual Rows']==1 and body_scans[0]['Actual Loops']==limit,'Expected one body lookup per key')
     require(not any(n['Index Name']=='idx_messages_created' for n in scan_nodes),'Chosen query scanned global history')
   checks.append({'name':name+' both samples use limited scoped keys plus one PK lookup per key','passed':True})
(HERE/'queries.json').write_text(json.dumps({shape:query(shape,False,50) for shape in ['direct','keys_materialized','keys_lateral']},indent=2)+'\n')
(HERE/'plans.json').write_text(json.dumps(plans,indent=2)+'\n')
e={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'postgres':sql('SELECT version();'),'checks':checks,'summary':summary,'fixture':noise['target'],'noise':noise['noise'],'limits':['Read-only owner SQL, no API or auth proof','Plan cache settings transaction-local comparison only; no production hint','Fixed server page limit; tenant/conversation and cursor values are prepared parameters','Two warmed samples, no cache flush; no global setting/index/statistics/data changes']}
(HERE/'evidence.json').write_text(json.dumps(e,indent=2)+'\n');print(json.dumps(summary,indent=2))
