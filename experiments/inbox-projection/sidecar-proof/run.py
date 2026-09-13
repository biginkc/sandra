#!/usr/bin/env python3
"""Fixed offline fixture only. Every rehearsal transaction ends in ROLLBACK."""
from pathlib import Path
import subprocess,json,uuid,time,hashlib,statistics,sys
HERE=Path(__file__).resolve().parent
HOST='unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'
NAME='sandra-inbox-projection-t2-db'
ID='603c10117cb7ef6a07d81448dd1a25b0c1ee2787a59f75871015c4a416cac557'
D=['docker','--host',HOST]
def sql(body):
 r=subprocess.run(D+['exec','-i',NAME,'psql','-X','-qAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=body,text=True,capture_output=True,timeout=45)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout.strip()
def guard():
 d=json.loads(subprocess.check_output(D+['inspect',NAME],text=True))[0]
 if d['Id']!=ID or d['HostConfig']['NetworkMode']!='none' or d['HostConfig'].get('PortBindings') or not d['State']['Running'] or d['Config']['Labels'].get('purpose')!='sandra-inbox-projection-t2':raise RuntimeError('Wrong or nonisolated container')
 if sql("SHOW cron.launch_active_jobs;")!='off':raise RuntimeError('Cron enabled')
 if sql("SELECT marker FROM inbox_t2_fixture.identity;")!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong fixture marker')
 if sql("SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname='inbox_capture_inbound_head';")!='O':raise RuntimeError('Candidate not enabled')
 if sql("SELECT to_regnamespace('inbox_t2_sidecar') IS NULL;")!='t':raise RuntimeError('Sidecar schema already exists')
guard()
alt=(HERE/'alternative.sql').read_text()
ORG=str(uuid.uuid4()); CONV=str(uuid.uuid4()); OTHER=str(uuid.uuid4()); MID=str(uuid.uuid4())
prefix="BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s';"
seed=f"INSERT INTO public.organizations(id,name) VALUES('{ORG}','T2 sidecar synthetic');"
def insert(mid=MID,conv=CONV,direction='inbound'):
 return f"INSERT INTO public.messages(id,org_id,conversation_id,channel,direction,body) VALUES('{mid}','{ORG}','{conv}','sms','{direction}','T2 sidecar synthetic');"
def check(condition,label):
 return "DO $$ BEGIN IF ("+condition+") IS DISTINCT FROM TRUE THEN RAISE EXCEPTION '"+label+"'; END IF; END $$;"
def rev(n):return f"(SELECT revision FROM inbox_t2_sidecar.arrivals WHERE message_id='{MID}')={n}"
def absent():return f"NOT EXISTS(SELECT 1 FROM inbox_t2_sidecar.arrivals WHERE message_id='{MID}')"
steps=[]
def step(label,body,condition):steps.append((label,body+check(condition,label)))
# Baseline inserted before installing alternative: absence represents zero.
BASELINE=str(uuid.uuid4())
base=insert(direction='outbound')+insert(mid=BASELINE)
step('baseline absence is zero','',f"coalesce((SELECT revision FROM inbox_t2_sidecar.arrivals WHERE message_id='{BASELINE}'),0)=0")
step('membership entry allocates one',f"UPDATE public.messages SET direction='inbound' WHERE id='{MID}';",rev(1))
step('body edit preserves arrival',f"UPDATE public.messages SET body='corrected' WHERE id='{MID}';",rev(1))
step('move allocates destination revision',f"UPDATE public.messages SET conversation_id='{OTHER}' WHERE id='{MID}';",rev(1)+f" AND (SELECT conversation_id FROM inbox_t2_sidecar.arrivals WHERE message_id='{MID}')='{OTHER}'")
step('return allocates fresh revision',f"UPDATE public.messages SET conversation_id='{CONV}' WHERE id='{MID}';",rev(2))
step('channel exit clears mapping',f"UPDATE public.messages SET channel='email' WHERE id='{MID}';",absent())
step('channel reentry allocates fresh revision',f"UPDATE public.messages SET channel='sms' WHERE id='{MID}';",rev(3))
step('delete clears mapping retains head',f"DELETE FROM public.messages WHERE id='{MID}';",absent()+f" AND (SELECT revision FROM public.inbox_inbound_heads WHERE org_id='{ORG}' AND conversation_id='{CONV}')=3")
step('reinsert same id gets fresh revision',insert(),rev(4))
step('savepoint rollback restores mapping and head',f"SAVEPOINT arrival; UPDATE public.messages SET direction='outbound' WHERE id='{MID}'; UPDATE public.messages SET direction='inbound' WHERE id='{MID}'; ROLLBACK TO arrival;",rev(4)+f" AND (SELECT revision FROM public.inbox_inbound_heads WHERE org_id='{ORG}' AND conversation_id='{CONV}')=4")
# Seed baseline before alternative installation, but outbound avoids allocation by committed candidate.
# A missing-row scalar expression is NULL, which must fail, never pass silently.
try:
 sql(prefix+seed+alt+check(f"(SELECT revision FROM inbox_t2_sidecar.arrivals WHERE message_id='{MID}')=1",'missing-row-negative')+'ROLLBACK;')
except RuntimeError as error:
 if 'missing-row-negative' not in str(error):raise
else:
 raise RuntimeError('Missing-row negative control was incorrectly accepted')
guard()
sql(prefix+seed+'ALTER TABLE public.messages DISABLE TRIGGER inbox_capture_inbound_head;'+base+alt+''.join(s[1] for s in steps)+'ROLLBACK;')
guard()
correctness={'status':'passed','containerId':ID,'role':'postgres','runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'alternative_sha256':hashlib.sha256(alt.encode()).hexdigest(),'checks':[x[0] for x in steps]+['outer rollback removes alternative schema and restores candidate trigger','missing-row NULL expression raises expected exception'],'supersedes':'Correctness assertions in earlier evidence.json used IF NOT(condition), which could silently accept NULL. Timings remain historical observations; this receipt replaces only that provisional correctness result.'}
(HERE/'correctness-evidence.json').write_text(json.dumps(correctness,indent=2)+'\n')
if '--correctness-only' in sys.argv:
 print(json.dumps(correctness,indent=2));sys.exit(0)
measurements=[]
# Same deterministic source identifiers/body and 100 rows in both variants.
# WAL insertion LSN delta includes all nested AFTER-trigger work; server elapsed
# excludes process startup, alternative DDL and fixture organization creation.
for run in range(3):
 for mode in (['candidate','sidecar'] if run%2==0 else ['sidecar','candidate']):
  guard()
  batch=f"INSERT INTO public.messages(id,org_id,conversation_id,channel,direction,body) SELECT md5('t2-ab-'||i)::uuid,'{ORG}','{CONV}','sms','inbound',repeat('synthetic body ',100) FROM generate_series(1,100) i;"
  bench="CREATE TEMP TABLE measurement(value jsonb); DO $$ DECLARE l pg_lsn; t timestamptz; elapsed numeric; bytes numeric; BEGIN l:=pg_current_wal_insert_lsn(); t:=clock_timestamp(); "+batch+" elapsed:=extract(epoch FROM clock_timestamp()-t)*1000; bytes:=pg_wal_lsn_diff(pg_current_wal_insert_lsn(),l); INSERT INTO measurement VALUES(jsonb_build_object('server_ms',elapsed,'wal_bytes',bytes)); END $$; SELECT value FROM measurement;"
  join=" LEFT JOIN inbox_t2_sidecar.arrivals a ON a.message_id=m.id AND a.org_id=m.org_id AND a.conversation_id=m.conversation_id" if mode=='sidecar' else ''
  revision="coalesce(a.revision,0)" if mode=='sidecar' else 'm.inbox_inbound_revision'
  scope=f"m.org_id='{ORG}' AND m.conversation_id='{CONV}' AND m.channel='sms' AND m.direction='inbound'"
  queries={
   'detail_50':f"SELECT m.id,m.body,{revision} AS revision FROM public.messages m{join} WHERE {scope} ORDER BY m.created_at DESC,m.id DESC LIMIT 50",
   'read_boundary_50':f"SELECT m.id FROM public.messages m{join} WHERE {scope} AND m.read_at IS NULL AND {revision}<=100 ORDER BY m.id LIMIT 50"
  }
  # EXPLAIN ANALYZE executes the actual bounded read query, after the write sample.
  # Return complete plans so join/index choices and buffers can be inspected.
  reads=''
  for label,query in queries.items():
   reads+="DO $read$ DECLARE p json; BEGIN EXECUTE $query$EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+query+"$query$ INTO p; UPDATE measurement SET value=value||jsonb_build_object('"+label+"',p); END $read$;"
  bench=bench.replace(' SELECT value FROM measurement;','')
  value=json.loads(sql(prefix+(alt if mode=='sidecar' else '')+seed+bench+reads+'SELECT value FROM measurement; ROLLBACK;'))
  measurements.append({'mode':mode,'run':run+1,**value})
guard()
result={'status':'passed','containerId':ID,'role':'postgres','alternative_sha256':hashlib.sha256(alt.encode()).hexdigest(),'correctness_checks':[x[0] for x in steps]+['outer rollback removes alternative schema and restores candidate trigger'],'measurements':measurements,'medians':{mode:{field:statistics.median(x[field] for x in measurements if x['mode']==mode) for field in ['server_ms','wal_bytes']} for mode in ['candidate','sidecar']},'limitations':['Local synthetic 100-row batches, three observations per mode; not production throughput evidence','WAL insertion LSN is instance-wide and may include background activity; rolled-back trials still produce WAL','Candidate revision guard remains in both variants; sidecar avoids recursive canonical message update','Sidecar does not eliminate row-before-head lock inversion; legacy multi-statement writers still require whole-transaction deadlock retry','No concurrent reader, authorization matrix or 90-day projection-expiry proof in this bounded comparison','All alternative DDL and synthetic data rolled back; committed candidate restored after each transaction']}
(HERE/'evidence.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
