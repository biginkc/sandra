#!/usr/bin/env python3
"""Bounded post-install observations, only the immutable owned offline fixture."""
if not __debug__:
    raise SystemExit("Refusing optimized Python: proof assertions must remain enabled")
import json, subprocess, uuid, time
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'fixture'))
from guards import validate_container, validate_cron
HERE=Path(__file__).resolve().parent
DOCKER=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
NAME='sandra-inbox-projection-t2-db'
c=json.loads(subprocess.check_output(DOCKER+['inspect',NAME],text=True,timeout=15))[0]
receipt=json.loads((HERE.parent/'fixture/bootstrap-result.json').read_text())
if not receipt.get('complete') or c['Id']!=receipt['containerId'] or c['HostConfig']['NetworkMode']!='none' or c['HostConfig'].get('PortBindings'):raise RuntimeError('Wrong fixture')
def sql(s):
 p=subprocess.run(DOCKER+['exec','-i',NAME,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=s,text=True,capture_output=True,check=True,timeout=180);return p.stdout.strip()
validate_container(c)
validate_cron(sql('SHOW cron.launch_active_jobs;'))
assert sql('SELECT marker FROM inbox_t2_fixture.identity;')=='sandra-inbox-projection-t2-owned-synthetic'
org=str(uuid.uuid4());a=str(uuid.uuid4());b=str(uuid.uuid4());mid=str(uuid.uuid4())
sql(f"INSERT INTO organizations(id,name) VALUES('{org}','T2 supplemental synthetic');INSERT INTO messages(id,org_id,conversation_id,channel,direction,body) VALUES('{mid}','{org}','{a}','sms','inbound','T2 return probe');INSERT INTO messages(org_id,conversation_id,channel,direction,body) SELECT '{org}','{b}','sms','inbound','T2 destination' FROM generate_series(1,2);")
returned=sql(f"UPDATE messages SET conversation_id='{b}' WHERE id='{mid}' RETURNING inbox_inbound_revision::text;")
final=sql(f"SELECT inbox_inbound_revision::text FROM messages WHERE id='{mid}';")
assert returned=='1' and final=='3'
# Compare in rollback-only transactions. DISABLE is held under table lock and
# cannot leak into committed fixture behavior. Canonical BEFORE guards remain on.
def sample(disable):
 conv=str(uuid.uuid4());toggle='ALTER TABLE public.messages DISABLE TRIGGER inbox_capture_inbound_head;' if disable else ''
 result=sql("BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='15s';"+toggle+"SELECT pg_current_wal_insert_lsn() AS before_lsn, clock_timestamp() AS before_time \\gset\n"+f"INSERT INTO messages(org_id,conversation_id,channel,direction,body) SELECT '{org}','{conv}','sms','inbound','T2 WAL probe' FROM generate_series(1,100);\n"+"SELECT json_build_object('wal_insert_bytes',pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'before_lsn'),'server_elapsed_ms',extract(epoch FROM clock_timestamp()- :'before_time'::timestamptz)*1000);ROLLBACK;")
 return json.loads(result.splitlines()[-1])
base=[sample(True) for _ in range(3)];capture=[sample(False) for _ in range(3)]
assert sql("SELECT tgenabled FROM pg_trigger WHERE tgrelid='messages'::regclass AND tgname='inbox_capture_inbound_head';")=='O'
metrics=json.loads(sql("SELECT json_build_object('n_tup_ins',n_tup_ins,'n_tup_upd',n_tup_upd,'n_dead_tup_estimate',n_dead_tup) FROM pg_stat_all_tables WHERE relid='messages'::regclass;"))
evidence={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checks':[{'name':'UPDATE RETURNING retains old revision while following SELECT sees final AFTER stamp','passed':True,'returning_revision':returned,'final_revision':final},{'name':'rollback-only benchmark does not persist capture disable','passed':True}],'baseline_capture_disabled_100_rows':base,'capture_enabled_100_rows':capture,'whole_fixture_pg_stat_estimates':metrics,'limits':['Capture-disabled control exists only inside rollback transaction on exclusively owned offline fixture; no other canonical trigger disabled','WAL insertion LSN delta includes whole isolated server activity and rollback work is not free; not a production ingestion budget','Three samples and100rows cannot establish tail latency or capacity','n_dead_tup is asynchronous estimated whole-fixture state, not exact per-operation dead tuple count; self-stamp creates extra MVCC updates','AFTER INSERT and UPDATE RETURNING are not safe final revision DTOs; perform final snapshot read','Later AFTER projection must enqueue identity keys/recompute authoritative state, not overwrite from stale outer NEW']}
(HERE/'supplement-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
