#!/usr/bin/env python3
"""Bounded offline read index comparison. Requires root's exclusive DB grant."""
if not __debug__:
    raise SystemExit('Refusing optimized Python: proof assertions must remain enabled')
import json, subprocess, time, uuid
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'fixture'))
from guards import validate_container, validate_cron
HERE=Path(__file__).resolve().parent
DOCKER=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
NAME='sandra-inbox-projection-t2-db'
PSQL=DOCKER+['exec','-i',NAME,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
def sql(text,check=True):
 p=subprocess.run(PSQL,input=text,text=True,capture_output=True,timeout=180)
 if check and p.returncode:raise RuntimeError(p.stderr)
 return p.stdout.strip() if check else p

def require(value,message):
 if value is not True:raise RuntimeError(message)
def uid():return str(uuid.uuid4())
def explain(statement,mutating=False):
 prefix="BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='60s';"
 return json.loads(sql(prefix+'EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) '+statement+'ROLLBACK;'))[0]
def history(org,conv,limit=50,cursor=None):
 seek='' if cursor is None else f" AND (created_at,id)<('{cursor['created_at_raw']}'::timestamptz,'{cursor['id']}'::uuid)"
 return f"SELECT id,created_at::text AS created_at_raw,body,inbox_inbound_revision::text AS revision FROM public.messages WHERE org_id='{org}' AND conversation_id='{conv}' AND channel='sms'{seek} ORDER BY created_at DESC,id DESC LIMIT {limit};"
def batch(org,conv,boundary,revision_order):
 order='inbox_inbound_revision,id' if revision_order else 'id'
 return f"""WITH eligible AS MATERIALIZED (
 SELECT id FROM public.messages WHERE org_id='{org}' AND conversation_id='{conv}' AND channel='sms' AND direction='inbound' AND read_at IS NULL AND inbox_inbound_revision<={int(boundary)}::bigint ORDER BY {order} LIMIT 200 FOR UPDATE
), changed AS (UPDATE public.messages m SET read_at=statement_timestamp() FROM eligible e WHERE m.id=e.id AND m.org_id='{org}' AND m.conversation_id='{conv}' AND m.channel='sms' AND m.direction='inbound' AND m.read_at IS NULL AND m.inbox_inbound_revision<={int(boundary)}::bigint RETURNING m.id) SELECT count(*) FROM changed;"""
def rows(statement):return json.loads(sql('SELECT coalesce(json_agg(row_to_json(q)),\'[]\'::json) FROM ('+statement.rstrip(';')+') q;'))
def scan_summary(plan):
 found=[]
 def visit(node):
  if 'Scan' in node['Node Type'] or node['Node Type']=='Sort':found.append({k:node.get(k) for k in ['Node Type','Relation Name','Index Name','Actual Rows','Actual Loops','Rows Removed by Filter','Shared Hit Blocks','Shared Read Blocks','Sort Method']})
  for child in node.get('Plans',[]):visit(child)
 visit(plan['Plan']);return {'execution_ms':plan['Execution Time'],'planning_ms':plan['Planning Time'],'nodes':found}
c=json.loads(subprocess.check_output(DOCKER+['inspect',NAME],text=True,timeout=15))[0];receipt=json.loads((HERE.parent/'fixture/bootstrap-result.json').read_text())
require(receipt.get('complete') is True and c['Id']==receipt.get('containerId'),'Wrong fixture identity')
require(c['HostConfig']['NetworkMode']=='none' and not c['HostConfig'].get('PortBindings') and c['State']['Running'] is True,'Fixture must be running and offline')
validate_container(c)
validate_cron(sql('SHOW cron.launch_active_jobs;'))
require(sql('SELECT marker FROM inbox_t2_fixture.identity;')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture marker')
require(sql("SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname='inbox_capture_inbound_head';")=='O','Head capture unavailable')
# No production migration. Never drop/rebuild someone else's indexes or disable triggers.
index_names=['t2_proof_history_idx','t2_proof_unread_idx']
require(sql("SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(ARRAY['t2_proof_history_idx','t2_proof_unread_idx']);")=='0','Prior index proof exists; coordinate a fresh fixture instead of dropping indexes')
triggers=rows("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND NOT tgisinternal ORDER BY tgname;")
cohorts=[];baseline={};after={};checks=[]
for n in [1000,10000,100000]:
 org=uid();conv=uid();started=time.perf_counter()
 sql(f"INSERT INTO public.organizations(id,name) VALUES('{org}','T2 index synthetic {n} {org}');")
 for first in range(1,n+1,1000):
  last=min(first+999,n)
  sql(f"BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';INSERT INTO public.messages(org_id,conversation_id,channel,direction,body,created_at) SELECT '{org}','{conv}','sms','inbound','T2 index synthetic '||repeat('x',160),'2026-09-01'::timestamptz+(n/10)*interval '0.000001 second' FROM generate_series({first},{last})n;COMMIT;")
 cohort={'rows':n,'org':org,'conv':conv,'seed_client_ms':(time.perf_counter()-started)*1000};cohorts.append(cohort)
 require(sql(f"SELECT revision::text FROM public.inbox_inbound_heads WHERE org_id='{org}' AND conversation_id='{conv}';")==str(n),'Every canonical insert must allocate its revision')
 sql('ANALYZE public.messages;ANALYZE public.inbox_inbound_heads;')
 # Run twice; report both rather than call the first a cold-cache observation.
 baseline[str(n)]={'history':[explain(history(org,conv)) for _ in range(2)],'batch_id_order':[explain(batch(org,conv,200,False),True) for _ in range(2)]}
index_sql=["CREATE INDEX t2_proof_history_idx ON public.messages(org_id,conversation_id,created_at DESC,id DESC) WHERE channel='sms';", "CREATE INDEX t2_proof_unread_idx ON public.messages(org_id,conversation_id,inbox_inbound_revision,id) WHERE channel='sms' AND direction='inbound' AND read_at IS NULL;"]
creation=[]
for name,statement in zip(index_names,index_sql):
 start=time.perf_counter();sql("BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='60s';"+statement+'COMMIT;');creation.append({'name':name,'client_ms':(time.perf_counter()-start)*1000,'bytes':int(sql(f"SELECT pg_relation_size('public.{name}'::regclass);"))})
sql('ANALYZE public.messages;')
for cohort in cohorts:
 n,org,conv=cohort['rows'],cohort['org'],cohort['conv']
 after[str(n)]={'history':[explain(history(org,conv)) for _ in range(2)],'batch_revision_order':[explain(batch(org,conv,200,True),True) for _ in range(2)]}
 # A microsecond timestamp boundary deliberately cuts through10-row ties.
 first=rows(history(org,conv,37));second=rows(history(org,conv,37,first[-1]));expected=rows(history(org,conv,74))
 require([r['id'] for r in first+second]==[r['id'] for r in expected],'raw timestamp+UUID seek lost/duplicated tie rows')
 checks.append({'name':f'{n}: raw-microsecond timestamp and UUID cursor traverses tie without gap/duplicate','passed':True,'cursor_created_at_raw':first[-1]['created_at_raw']})
 changed=int(sql("BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';"+batch(org,conv,200,True)+'COMMIT;'));require(changed==200,'Expected exactly200 acknowledged old arrivals')
 require(sql(f"SELECT count(*) FROM messages WHERE org_id='{org}' AND conversation_id='{conv}' AND inbox_inbound_revision>200 AND read_at IS NOT NULL;")=='0','Late rows incorrectly acknowledged')
 after[str(n)]['late_only_empty_batch']=[explain(batch(org,conv,200,True),True) for _ in range(2)]
 require(int(sql(batch(org,conv,200,True)))==0,'Late-only completion incorrectly changed rows')
 checks.append({'name':f'{n}: fixed200 boundary marks exactly200; remaining{n-200} late-only rows stay unread','passed':True})
summary={str(c['rows']):{'baseline_history':scan_summary(baseline[str(c['rows'])]['history'][-1]),'indexed_history':scan_summary(after[str(c['rows'])]['history'][-1]),'baseline_batch':scan_summary(baseline[str(c['rows'])]['batch_id_order'][-1]),'indexed_batch':scan_summary(after[str(c['rows'])]['batch_revision_order'][-1]),'late_only_empty':scan_summary(after[str(c['rows'])]['late_only_empty_batch'][-1])} for c in cohorts}
for n,summary_entry in summary.items():
 scans=[node for node in summary_entry['late_only_empty']['nodes'] if node['Index Name']=='t2_proof_unread_idx']
 require(bool(scans) and all(node['Actual Rows']==0 and node['Rows Removed by Filter'] in (None,0) for node in scans),'Late-only plan must use unread index without scanning later arrivals')
 checks.append({'name':f'{n}: actual late-only plan uses unread index with zero candidate rows and zero filter rejections','passed':True})
evidence={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'source_revision':receipt['source_revision'],'container_id':c['Id'],'cohorts':cohorts,'message_triggers':triggers,'load_method':'committed batches of at most1000 messages, 30s statement timeout, canonical head and projection dirty capture enabled','checks':checks,'index_creation':creation,'summary':summary,'distribution':{'each_cohort':'one org and one conversation, inbound SMS only, body179ASCII bytes, metadataNULL,10rows per microsecond timestamp tie','eligible_boundary':200,'late_rows':'all remaining revisions>200; kept unread','cache':'two repeated plan samples; no cache flush, data/index caches warmed by inserts/index build','shared_table':'contains earlier T2 synthetic fixtures plus111000 new rows'},'limits':['Offline synthetic sweep capped100k cohort, no production capacity/latency certification','Index creation uses regular CREATE INDEX in exclusive fixture, not production concurrent migration rehearsal','Bounded200 mutations do not by themselves prove bounded joined UPDATE execution; inspect recorded plans','Revision/id traversal changes lock order and requires concurrency integration before production','Projection dirty capture remains enabled; this is not a comparative write-amplification measurement','No canonical trigger disabled, heads reset or existing data deleted']}
(HERE/'plans.json').write_text(json.dumps({'baseline':baseline,'indexed':after},indent=2)+'\n');(HERE/'evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
