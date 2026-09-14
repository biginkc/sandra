#!/usr/bin/env python3
"""Owned candidate proof: strict read-retention budgets, deadline safety and held locks."""
import argparse,json,subprocess,time,uuid
from pathlib import Path
from fixture_db import guard,sql,D,N,DB
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--owned-fixture',action='store_true');ap.add_argument('--install',action='store_true');a=ap.parse_args()
if not a.owned_fixture:raise SystemExit('Explicit owned fixture required')
guard()
if a.install:
 if sql("SELECT to_regprocedure('inbox_read.prune_expired_boundaries(integer)') IS NOT NULL")=='t':raise RuntimeError('Retention exists; verify rather than blindly replace')
 sql('BEGIN;'+(P/'read-retention.sql').read_text()+'COMMIT;')
old,active,executing,recent,held,u,o,c,g=[str(uuid.uuid4()) for _ in range(9)]
probe=sql(f"""BEGIN;
INSERT INTO inbox_read.boundaries(id,requester_id,org_id,conversation_id,generation,revision,created_at,expires_at,execution_deadline,session_id,access_epoch)
VALUES
('{old}','{u}','{o}','{c}','{g}',0,clock_timestamp()-interval '101 years',clock_timestamp()-interval '100 years',NULL,'{u}',1),
('{active}','{u}','{o}','{c}','{g}',0,clock_timestamp(),clock_timestamp()+interval '5 minutes',NULL,'{u}',1),
('{executing}','{u}','{o}','{c}','{g}',0,clock_timestamp()-interval '9 days',clock_timestamp()-interval '8 days',clock_timestamp()+interval '5 minutes','{u}',1),
('{recent}','{u}','{o}','{c}','{g}',0,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',NULL,'{u}',1);
INSERT INTO inbox_read.history_cursors(boundary_id,session_id,access_epoch,before_at,before_id)
SELECT '{old}','{u}',1,clock_timestamp(),gen_random_uuid() FROM generate_series(1,800);
INSERT INTO inbox_read.receipts(boundary_id,batch,changed,completed) SELECT '{old}',n,0,false FROM generate_series(1,201)n;
INSERT INTO inbox_read.receipts VALUES('{active}',0,0,false),('{executing}',0,0,false),('{recent}',0,0,false);
DO $$ DECLARE result jsonb; BEGIN
 result:=inbox_read.prune_expired_boundaries(1000);
 IF (result->>'deleted_rows')::integer<>1000 OR (result->>'deleted_boundaries')::integer<>0 THEN RAISE EXCEPTION 'Read retention exceeded child budget';END IF;
 IF (SELECT count(*) FROM inbox_read.receipts WHERE boundary_id='{old}')<>1 THEN RAISE EXCEPTION 'Partial receipt cleanup did not resume';END IF;
 result:=inbox_read.prune_expired_boundaries(1000);
 IF (result->>'deleted_rows')::integer<>2 OR (result->>'deleted_boundaries')::integer<>1 THEN RAISE EXCEPTION 'Final child plus parent budget incorrect';END IF;
 IF (SELECT count(*) FROM inbox_read.receipts WHERE boundary_id IN ('{active}','{executing}','{recent}'))<>3 THEN RAISE EXCEPTION 'Active/deadline/grace receipt removed';END IF;
 IF (SELECT count(*) FROM inbox_read.boundaries WHERE id IN ('{active}','{executing}','{recent}'))<>3 THEN RAISE EXCEPTION 'Active/deadline/grace boundary removed';END IF;
END $$;SELECT 'retention_budget_and_deadlines_passed';ROLLBACK;""")
if probe!='retention_budget_and_deadlines_passed':raise RuntimeError('Retention probe receipt mismatch')
# A committed synthetic expired boundary allows a real independent lock race.
sql(f"INSERT INTO inbox_read.boundaries(id,requester_id,org_id,conversation_id,generation,revision,created_at,expires_at,session_id,access_epoch) VALUES('{held}','{u}','{o}','{c}','{g}',0,clock_timestamp()-interval '101 years',clock_timestamp()-interval '100 years','{u}',1)")
tag='inbox-owned-retention-'+held
query=f"SET application_name='{tag}';BEGIN;SELECT id FROM inbox_read.boundaries WHERE id='{held}' FOR UPDATE;SELECT pg_sleep(4);COMMIT;"
proc=subprocess.Popen(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d',DB,'-v','ON_ERROR_STOP=1','-c',query],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
 deadline=time.monotonic()+3
 while sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{tag}' AND wait_event='PgSleep')")!='t':
  if time.monotonic()>deadline:raise RuntimeError('Held boundary lock was not established')
  time.sleep(.05)
 result=json.loads(sql('SELECT inbox_read.prune_expired_boundaries(1000)'))
 if result['deleted_rows']!=0 or sql(f"SELECT count(*) FROM inbox_read.boundaries WHERE id='{held}'")!='1':raise RuntimeError('In-flight boundary was not skipped')
finally:
 output,error=proc.communicate(timeout=10)
 if proc.returncode:raise RuntimeError(error)
result=json.loads(sql('SELECT inbox_read.prune_expired_boundaries(1000)'))
if result['deleted_rows']!=1 or sql(f"SELECT count(*) FROM inbox_read.boundaries WHERE id='{held}'")!='0':raise RuntimeError('Unlocked expired boundary did not prune')
receipt={'passed':True,'checks':['total child and parent row budget','partial expired receipt cleanup resumes','future expiry preserved','future execution deadline preserved','seven-day grace preserved','actual held boundary skipped then deleted after release'],'scope':'Owned synthetic candidate; operations and safety receipts untouched'}
(P/'read-retention-evidence.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
