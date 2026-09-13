#!/usr/bin/env python3
if not __debug__: raise SystemExit('Optimized Python refused before fixture access')
import argparse,hashlib,json,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
parser=argparse.ArgumentParser();parser.add_argument('--run-owned-fixture',action='store_true');args=parser.parse_args()
if not args.run_owned_fixture: raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
def sql(q,check=True):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],input="SET statement_timeout='20s';SET lock_timeout='2s';"+q,capture_output=True,text=True,timeout=30)
 if check and r.returncode: raise RuntimeError(r.stderr)
 return r.stdout.strip() if check else r
validate_cron(sql('SHOW cron.launch_active_jobs'))
def need(value,label):
 if value is not True: raise RuntimeError(label)
def lit(v): return "'"+str(v).replace("'","''")+"'"
def uid():return str(uuid.uuid4())
need(sql("SELECT marker FROM inbox_t2_fixture.identity")=='sandra-inbox-projection-t2-owned-synthetic','marker')

need(sql("SELECT to_regclass('inbox_t2_maintained.queue') IS NULL")=='t','Queue already installed')
sql((P/'queue.sql').read_text())
checks=[]
def mark(name):checks.append({'name':name,'passed':True})
# Existing synthetic pending rows are claimed in one bounded transaction.
claims=json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]') FROM inbox_t2_maintained.claim_work(100,30) q"))
need(0<len(claims)<=100,'claim bound')
first=claims[0];o=first['org_id'];k=first['target_kind'];t=first['target_id'];token=first['claim_token']
def snap():return json.loads(sql(f"SELECT inbox_t2_maintained.snapshot('{o}',{lit(k)},'{t}',statement_timestamp())"))
def finish(tok,c):return sql(f"SELECT inbox_t2_maintained.finish_work('{tok}',{lit(json.dumps(c))}::jsonb)")
def row():return sql(f"SELECT count(*) FROM inbox_t2_maintained.queue WHERE org_id='{o}' AND target_kind={lit(k)} AND target_id='{t}'")
c=snap();need(finish(uid(),c)=='stale_claim','wrong worker accepted');need(row()=='1','wrong claim removed')
mark('bounded claims persist tokens and reject unrelated worker completion')
# Private fixture lease expiry simulates elapsed scheduling time; no production clock changes.
sql(f"UPDATE inbox_t2_maintained.queue SET available_at=statement_timestamp()-interval '1 second',lease_until=statement_timestamp()-interval '1 second' WHERE org_id='{o}' AND target_kind={lit(k)} AND target_id='{t}'")
need(finish(token,c)=='stale_claim','expired worker accepted')
again=json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]') FROM inbox_t2_maintained.claim_work(100,30) q"));new=next(q for q in again if q['target_id']==t and q['org_id']==o and q['target_kind']==k)
need(new['claim_token']!=token,'reclaim token reused');need(finish(token,c)=='stale_claim','reclaimed old worker accepted')
need(finish(new['claim_token'],c)=='applied' and row()=='0','current completion not dequeued')
mark('expired/reclaimed worker is fenced; fresh claim publishes and removes only caught-up work')
# Dirty generation and queue enqueue commit/rollback together.
base=sql(f"SELECT generation FROM inbox_t2_message_capture.dirty WHERE org_id='{o}' AND target_kind={lit(k)} AND target_id='{t}'")
update=f"UPDATE inbox_t2_message_capture.dirty SET generation=generation+1 WHERE org_id='{o}' AND target_kind={lit(k)} AND target_id='{t}'"
sql('BEGIN;'+update+';ROLLBACK;');need(row()=='0','rollback leaked queue')
sql(update);need(row()=='1','dirty did not enqueue');claim=json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]') FROM inbox_t2_maintained.claim_work(100,30) q"));q=next(q for q in claim if q['target_id']==t and q['org_id']==o and q['target_kind']==k);old=snap();sql(update)
need(finish(q['claim_token'],old)=='applied' and row()=='1','newer work dropped')
mark('enqueue is transactional; older publication leaves newer generation durably queued')
(P/'queue-evidence.json').write_text(json.dumps({'checks':checks,'queue_sql_sha256':hashlib.sha256((P/'queue.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Fixture lease expiry is controlled metadata manipulation, not a wall-clock/process-crash test','No daemon or production activation; no parent fanout or backfill race proof']},indent=2)+'\n')
print(json.dumps({'passed':len(checks),'checks':checks},indent=2))
