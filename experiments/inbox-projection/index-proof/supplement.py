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
c=json.loads(subprocess.check_output(DOCKER+['inspect',NAME],text=True,timeout=15))[0]
validate_container(c);validate_cron(sql('SHOW cron.launch_active_jobs;'))
require(sql('SELECT marker FROM inbox_t2_fixture.identity;')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture marker')
original=json.loads((HERE/'evidence.json').read_text())
cohort=next(x for x in original['cohorts'] if x['rows']==100000)
org,conv=cohort['org'],cohort['conv']
expected=rows(history(org,conv))
noiseorg=uid()
sql(f"INSERT INTO organizations(id,name) VALUES('{noiseorg}','T2 index noise {noiseorg}');")
noise=[]
for targetorg in [org,noiseorg]:
 targetconv=uid();noise.append({'org':targetorg,'conversation':targetconv,'rows':5000})
 for first in range(1,5001,1000):
  last=first+999
  sql(f"BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';INSERT INTO messages(org_id,conversation_id,channel,direction,body,created_at) SELECT '{targetorg}','{targetconv}','sms','inbound','T2 noise '||repeat('x',170),'2026-09-02'::timestamptz+n*interval '1 microsecond' FROM generate_series({first},{last})n;COMMIT;")
sql('ANALYZE messages;')
plans=[explain(history(org,conv)) for _ in range(2)]
actual=rows(history(org,conv))
require([x['id'] for x in actual]==[x['id'] for x in expected],'Unrelated arrivals changed target latest50 IDs')
require(len(actual)==50,'Expected exactly50 history rows')
evidence={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'container_id':c['Id'],'target':cohort,'noise':noise,'noise_created_at':'2026-09-02 plus microseconds; all later than target2026-09-01','load':'committed1000-row batches, all canonical and projection capture enabled','checks':[{'name':'same-org/different-conversation and other-org newer noise leaves exact latest50 target IDs unchanged','passed':True}],'expected_ids':[x['id'] for x in expected],'summary':[scan_summary(x) for x in plans],'limits':['Original evidence preserved; no index hints or dropped indexes','One10k newer-noise distribution is not a production guarantee']}
(HERE/'noise-plans.json').write_text(json.dumps(plans,indent=2)+'\n');(HERE/'noise-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
