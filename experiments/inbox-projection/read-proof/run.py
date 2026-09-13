#!/usr/bin/env python3
"""Offline SQL read protocol proof; no HTTP/API/token or end-user auth claim."""
if not __debug__:
    raise SystemExit('Refusing optimized Python: proof assertions must remain enabled')
import json, subprocess, uuid, time
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'fixture'))
from guards import validate_container, validate_cron
HERE=Path(__file__).resolve().parent
DOCKER=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
NAME='sandra-inbox-projection-t2-db'
PSQL=DOCKER+['exec','-i',NAME,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
c=json.loads(subprocess.check_output(DOCKER+['inspect',NAME],text=True,timeout=15))[0]
receipt=json.loads((HERE.parent/'fixture/bootstrap-result.json').read_text())
if not receipt.get('complete') or c['Id']!=receipt.get('containerId') or c['HostConfig']['NetworkMode']!='none' or c['HostConfig'].get('PortBindings') or not c['State']['Running']:raise RuntimeError('Refusing unrecognized/nonisolated fixture')
def sql(s,check=True):
 r=subprocess.run(PSQL,input=s,text=True,capture_output=True,timeout=180)
 if check and r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip() if check else r
validate_container(c)
validate_cron(sql('SHOW cron.launch_active_jobs;'))
if sql('SELECT marker FROM inbox_t2_fixture.identity;')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Missing fixture marker')
if sql("SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname='inbox_capture_inbound_head';")!='O':raise RuntimeError('Committed head capture unavailable')
def uid():return str(uuid.uuid4())
import select
processes=[]
def spawn(*args,**kwargs):
 p=subprocess.Popen(*args,**kwargs);processes.append(p);return p
def ready_line(process,timeout=10):
 readable,_,_=select.select([process.stdout],[],[],timeout)
 if not readable:raise RuntimeError('Timed out waiting for holder readiness')
 return process.stdout.readline().strip()
def close_processes():
 for process in processes:
  if process.stdin and not process.stdin.closed:
   try:process.stdin.close()
   except (BrokenPipeError,OSError):pass
  if process.poll() is None:
   process.terminate()
   try:process.wait(timeout=5)
   except subprocess.TimeoutExpired:
    process.kill();process.wait(timeout=5)

org=uid();otherorg=uid();conv=uid();otherconv=uid();checks=[]
def passed(name,**details):checks.append(dict(name=name,passed=True,**details))
def insert(mid,destination=conv,tenant=org,created="'2020-01-01'",extra=''):
 return f"INSERT INTO public.messages(id,org_id,conversation_id,channel,direction,body,created_at{', '+extra.split('=',1)[0] if extra else ''}) VALUES('{mid}','{tenant}','{destination}','sms','inbound','T2 read synthetic',{created}{', '+extra.split('=',1)[1] if extra else ''});"
def snapshot(destination=conv,tenant=org):
 return f"""WITH head AS MATERIALIZED (
 SELECT coalesce((SELECT revision FROM public.inbox_inbound_heads WHERE org_id='{tenant}' AND conversation_id='{destination}'),0)::text AS revision
), history AS MATERIALIZED (
 SELECT id,created_at::text AS created_at_raw,inbox_inbound_revision::text AS inbound_revision,direction,read_at::text AS read_at_raw
 FROM public.messages WHERE org_id='{tenant}' AND conversation_id='{destination}' AND channel='sms'
 ORDER BY created_at DESC,id DESC LIMIT 50
) SELECT json_build_object('head',(SELECT revision FROM head),'history',coalesce((SELECT json_agg(row_to_json(h) ORDER BY h.created_at_raw::timestamptz DESC,h.id DESC) FROM history h),'[]'::json));"""
def batch(boundary,destination=conv,tenant=org):
 return f"""WITH eligible AS MATERIALIZED (
 SELECT id FROM public.messages WHERE org_id='{tenant}' AND conversation_id='{destination}' AND channel='sms' AND direction='inbound' AND read_at IS NULL AND inbox_inbound_revision <= {int(boundary)}::bigint
 ORDER BY id LIMIT 200 FOR UPDATE
), changed AS (
 UPDATE public.messages m SET read_at=statement_timestamp() FROM eligible e WHERE m.id=e.id
 AND m.org_id='{tenant}' AND m.conversation_id='{destination}' AND m.channel='sms' AND m.direction='inbound' AND m.read_at IS NULL AND m.inbox_inbound_revision <= {int(boundary)}::bigint RETURNING m.id
) SELECT count(*) FROM changed;"""
def unread(mid):return sql(f"SELECT read_at IS NULL FROM messages WHERE id='{mid}';")=='t'
sql(f"INSERT INTO public.organizations(id,name) VALUES('{org}','T2 read proof {org}'),('{otherorg}','T2 read proof alternate {otherorg}');INSERT INTO public.messages(org_id,conversation_id,channel,direction,body,created_at) SELECT '{org}','{conv}','sms','inbound','T2 history '||n,'2026-09-01'::timestamptz+n*interval '0.000001 second' FROM generate_series(1,451)n;")
ids=json.loads(sql(f"SELECT json_agg(id ORDER BY created_at,id) FROM public.messages WHERE org_id='{org}' AND conversation_id='{conv}';"))
scope_otherorg=uid();scope_otherconv=uid();outbound=uid();email=uid()
sql(insert(scope_otherorg,tenant=otherorg)+insert(scope_otherconv,destination=otherconv)+insert(outbound).replace("'sms','inbound'","'sms','outbound'")+insert(email).replace("'sms','inbound'","'email','inbound'"))
# Leave an allocated source/head transaction uncommitted while one SQL snapshot reads.
try:
 heldid=uid();holder=spawn(PSQL,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 holder.stdin.write('BEGIN;'+insert(heldid,created="'2027-01-01'")+"\n\\echo held_ready\n");holder.stdin.flush();assert ready_line(holder)=='held_ready'
 view=json.loads(sql(snapshot()));boundary=view['head'];assert boundary=='451';assert len(view['history'])==50;assert [x['id'] for x in view['history']]==list(reversed(ids[-50:]));assert heldid not in [x['id'] for x in view['history']];assert all(int(x['inbound_revision'])<=int(boundary) for x in view['history'])
 holder.stdin.write('COMMIT;\n\\q\n');holder.stdin.flush();holder.wait(timeout=10);assert holder.returncode==0
 passed('one SQL MVCC snapshot excludes uncommitted head and message and returns latest50',boundary_text=boundary)
 lateid=uid();sql(insert(lateid,created="'1990-01-01'"));assert unread(lateid)
 # Captured rows moving out/re-entering or being reinserted become later arrivals.
 reinsert=ids[0];reenter=ids[1];movedout=ids[2]
 sql(f"DELETE FROM public.messages WHERE id='{reinsert}';"+insert(reinsert)+f"UPDATE public.messages SET conversation_id='{otherconv}' WHERE id='{reenter}';UPDATE public.messages SET conversation_id='{conv}' WHERE id='{reenter}';UPDATE public.messages SET conversation_id='{otherconv}' WHERE id='{movedout}';")
 plans={}
 plans['detail_snapshot']=json.loads(sql('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+snapshot()))
 plans['read_batch']=json.loads(sql('BEGIN;SET LOCAL lock_timeout=\'2s\';SET LOCAL statement_timeout=\'15s\';EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) '+batch(boundary)+'ROLLBACK;'))
 assert sql(f"SELECT count(*) FROM public.messages WHERE org_id='{org}' AND conversation_id='{conv}' AND read_at IS NOT NULL;")=='0'
 counts=[]
 for _ in range(10):
  count=int(sql("BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='15s';"+batch(boundary)+'COMMIT;'))
  counts.append(count)
  if count==0:break
 else:raise AssertionError('batch bound failed')
 assert counts==[200,200,48,0]
 assert sql(f"SELECT count(*) FROM public.messages WHERE org_id='{org}' AND conversation_id='{conv}' AND channel='sms' AND direction='inbound' AND inbox_inbound_revision<={boundary} AND read_at IS NULL;")=='0'
 passed('latest50 render boundary acknowledges448 eligible rows in bounded200-row transactions',changed_per_batch=counts)
 assert all(unread(x) for x in [heldid,lateid,reinsert,reenter,movedout,scope_otherorg,scope_otherconv,outbound,email])
 passed('later/backdated, reinserted, re-entered and moved-out rows remain unread')
 passed('explicit org/conversation/SMS/inbound predicates leave alternate tenant/conversation and noninbound rows untouched')
 assert sql(f"SELECT revision::text FROM inbox_inbound_heads WHERE org_id='{org}' AND conversation_id='{conv}';")=='455';passed('read batches do not advance inbound arrival head')
 # Canonical permanent DNC is acquired after the detail boundary was read.
 dncconv=uid();prop=uid();good,bad=sorted([uid(),uid()]);sql(f"INSERT INTO properties(id,org_id,address,state,status) VALUES('{prop}','{org}','T2 fictional DNC property','MO','new_lead');"+insert(good,destination=dncconv)+insert(bad,destination=dncconv,extra=f"property_id='{prop}'"))
 dncview=json.loads(sql(snapshot(dncconv)));assert dncview['head']=='2';sql(f"UPDATE properties SET outreach_dispo='dnc' WHERE id='{prop}';");assert sql(f"SELECT is_dnc_locked FROM properties WHERE id='{prop}';")=='t'
 failed=sql("BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='15s';"+batch(dncview['head'],dncconv)+'COMMIT;',False)
 assert failed.returncode!=0 and 'DNC_LOCKED' in failed.stderr;assert unread(good) and unread(bad)
 passed('permanentDNC acquired after snapshot rejects batch and both selected rows remain unread',rows_still_unread=2)
 (HERE/'plans.json').write_text(json.dumps(plans,indent=2)+'\n')
 evidence={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'source_revision':receipt['source_revision'],'container_id':c['Id'],'checks':checks,'sql_snapshot':snapshot(),'sql_batch':batch(boundary),'limits':['PostgreSQL owner executes explicit scoped protocol SQL; no ordinary-user authentication/authorization proof','No API, signed boundary, requester binding, expiry, receipt persistence or browser render acknowledgment implemented','No SKIP LOCKED; lock timeout is bounded and error exits whole transaction, production retry still separate','Plans describe small offline canonical fixture, not production cardinality or performance budgets','One snapshot SQL returns head/history together; unrelated detail context and permission lifecycle are not included','Snapshot-only header uses text revision; SQL casts trusted testboundary tobigint, not untrusted token validation']}
 (HERE/'evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps({'passed':len(checks),'checks':checks},indent=2))
finally:
 close_processes()
