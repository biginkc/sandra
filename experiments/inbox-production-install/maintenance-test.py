#!/usr/bin/env python3
"""Bounded synthetic baseline and natural expiry proof; never accepts production connection data."""
import argparse,json,subprocess,sys,time,uuid
from pathlib import Path
from fixture_db import guard,sql
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--owned-fixture',action='store_true');a=ap.parse_args()
if not a.owned_fixture:raise SystemExit('Explicit owned fixture required')
guard();before_gate=sql('SELECT serving_enabled FROM inbox_control.rollout WHERE singleton')
o,u,v,c,p,m,conv=[str(uuid.uuid4()) for _ in range(7)]
# Deliberately model a row predating capture. The entire baseline probe rolls back,
# including its temporary checkpoint reset; no other user's epochs are changed.
baseline=sql(f"""BEGIN;
INSERT INTO organizations(id,name) VALUES('{o}','Baseline proof');
INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.test'),('{v}','{v}@example.test');
INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{u}','{o}','owner','active'),('{v}','{o}','member','active');
DELETE FROM inbox_bridge.access_epochs WHERE user_id='{u}';
UPDATE inbox_bridge.access_epochs SET revision=73 WHERE user_id='{v}';
UPDATE inbox_control.baseline_progress SET stage='memberships',cursor=NULL WHERE singleton;
DO $$ DECLARE rounds integer:=0; BEGIN
 WHILE (SELECT stage='memberships' FROM inbox_control.baseline_progress WHERE singleton) LOOP
  PERFORM inbox_control.seed_baseline_batch(1000);rounds:=rounds+1;
  IF rounds>10 THEN RAISE EXCEPTION 'Unexpected baseline volume';END IF;
 END LOOP;
 IF (SELECT revision FROM inbox_bridge.access_epochs WHERE user_id='{u}') IS DISTINCT FROM 1::bigint THEN RAISE EXCEPTION 'Missing historical epoch not seeded';END IF;
 IF (SELECT revision FROM inbox_bridge.access_epochs WHERE user_id='{v}') IS DISTINCT FROM 73::bigint THEN RAISE EXCEPTION 'Existing epoch reset';END IF;
 IF EXISTS(SELECT 1 FROM auth.sessions WHERE user_id IN ('{u}','{v}')) THEN RAISE EXCEPTION 'Probe unexpectedly has logged-in member';END IF;
END $$;
SELECT 'historical_epoch_and_preservation_passed';ROLLBACK;""")
if baseline!='historical_epoch_and_preservation_passed':raise RuntimeError('Baseline receipt mismatch')
# A cursor-heavy expired scope cannot turn one selected workset into unbounded
# deletion. This probe creates synthetic retained rows and rolls back everything.
retention=sql(f"""BEGIN;
INSERT INTO inbox_bridge.worksets(id,org_id,user_id,session_id,access_epoch,generation,created_at,expires_at,filter,targets,handles)
VALUES('{conv}','{o}','{u}','{v}',1,1,clock_timestamp()-interval '101 years',clock_timestamp()-interval '100 years','{{}}','[]','[null]');
INSERT INTO inbox_bridge.cursors(scope_id,latest_at,target_kind,target_id)
SELECT '{conv}',clock_timestamp(),'known_conversation',gen_random_uuid() FROM generate_series(1,2001);
DO $$ DECLARE n integer; BEGIN
 n:=inbox_control.prune_expired_worksets(1,86400);
 IF n<>0 OR (SELECT count(*) FROM inbox_bridge.cursors WHERE scope_id='{conv}')<>1001 THEN RAISE EXCEPTION 'First cursor deletion exceeded budget';END IF;
 n:=inbox_control.prune_expired_worksets(1,86400);
 IF n<>0 OR (SELECT count(*) FROM inbox_bridge.cursors WHERE scope_id='{conv}')<>1 THEN RAISE EXCEPTION 'Cursor resume exceeded budget';END IF;
 n:=inbox_control.prune_expired_worksets(1,86400);
 IF n<>1 OR EXISTS(SELECT 1 FROM inbox_bridge.worksets WHERE id='{conv}') THEN RAISE EXCEPTION 'Final bounded prune failed';END IF;
END $$;
SELECT 'cursor_budget_passed';ROLLBACK;""")
if retention!='cursor_budget_passed':raise RuntimeError('Retention receipt mismatch')
fks=json.loads(sql("SELECT coalesce(jsonb_agg(conrelid::regclass::text),'[]') FROM pg_constraint WHERE contype='f' AND confrelid='inbox_bridge.worksets'::regclass"))
if fks!=['inbox_bridge.cursors']:raise RuntimeError('Unexpected durable workset dependency requires retention review')
# Exactly one canonical inbound message approaches its actual window deadline.
# No update or deletion to this message follows the initial INSERT.
sql(f"""BEGIN;
INSERT INTO organizations(id,name) VALUES('{o}','Natural expiry proof');
INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Expiry contact');
INSERT INTO properties(id,org_id,address,state,status,homeowner_contact_id) VALUES('{p}','{o}','Expiry property','MO','contacted','{c}');
INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address,created_at) VALUES('{m}','{o}','{conv}','{c}','{p}','sms','inbound','received','Natural expiry inquiry','+18165550102','+18162804181',clock_timestamp()-interval '2160 hours'+interval '30 seconds');COMMIT;""")
def drain():return json.loads(subprocess.check_output([sys.executable,str(P/'worker-step.py'),'--owned-fixture','--rounds','4'],text=True))
first=drain()
if sql(f"SELECT count(*) FROM inbox_bridge.summaries WHERE org_id='{o}' AND target_id='{conv}'")!='1':raise RuntimeError('Message was not visible before natural deadline')
remaining=float(sql(f"SELECT extract(epoch FROM next_expiry-clock_timestamp()) FROM inbox_maintained.rows WHERE org_id='{o}' AND target_id='{conv}'"))
if remaining<0 or remaining>31:raise RuntimeError('Unexpected natural expiry clock')
time.sleep(remaining+0.2)
second=drain()
if second['processed']['expiry']<1:raise RuntimeError('No natural expiry wake observed')
if sql(f"SELECT count(*) FROM inbox_bridge.summaries WHERE org_id='{o}' AND target_id='{conv}'")!='0':raise RuntimeError('Natural expiry did not remove summary')
if sql('SELECT serving_enabled FROM inbox_control.rollout WHERE singleton')!=before_gate:raise RuntimeError('Maintenance changed serving gate')
receipt={'passed':True,'checks':['modeled historical member with no session receives baseline epoch','existing epoch 73 preserved','baseline checkpoint probe entirely rolled back','natural deadline without canonical update wakes queue and removes summary','serving gate preserved','2001 cursor rows pruned across three bounded calls','only cursor table references worksets in installed catalog'],'worker_passes':[first,second],'scope':'Owned fixture; historical gap deliberately modeled, not a second pre-install database; natural expiry is actual wall-clock execution. worker_passes[].readiness.serving_enabled reflects this owned fixture database only (separately authorized per README, "Browser fixture enablement is separately authorized and does not change production defaults") and is not a live production serving-gate enable.'}
(P/'maintenance-evidence.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
