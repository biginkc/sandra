#!/usr/bin/env python3
import argparse,json,uuid
from pathlib import Path
from fixture_db import guard,sql
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--owned-fixture',action='store_true');a=ap.parse_args()
if not a.owned_fixture:raise SystemExit('Explicit owned fixture required')
guard();o,g,u,s=[str(uuid.uuid4()) for _ in range(4)]
result=sql(f"""BEGIN;
INSERT INTO inbox_read.unknown_history_cursors(org_id,sender_group_id,requester_id,session_id,access_epoch,expires_at,before_at,before_id)
SELECT '{o}','{g}','{u}','{s}',1,clock_timestamp()-interval '100 years',clock_timestamp(),gen_random_uuid() FROM generate_series(1,1001);
INSERT INTO inbox_read.unknown_history_cursors(org_id,sender_group_id,requester_id,session_id,access_epoch,expires_at,before_at,before_id)
VALUES('{o}','{g}','{u}','{s}',1,clock_timestamp()+interval '5 minutes',clock_timestamp(),gen_random_uuid()),('{o}','{g}','{u}','{s}',1,clock_timestamp()-interval '1 day',clock_timestamp(),gen_random_uuid());
DO $$ DECLARE n integer; BEGIN
 n:=inbox_read.prune_expired_unknown_cursors(1000);
 IF n<>1000 OR (SELECT count(*) FROM inbox_read.unknown_history_cursors WHERE org_id='{o}')<>3 THEN RAISE EXCEPTION 'Unknown cursor budget failed';END IF;
 n:=inbox_read.prune_expired_unknown_cursors(1000);
 IF n<>1 OR (SELECT count(*) FROM inbox_read.unknown_history_cursors WHERE org_id='{o}')<>2 THEN RAISE EXCEPTION 'Unknown cursor grace/active preservation failed';END IF;
END $$;SELECT 'unknown_retention_passed';ROLLBACK;""")
if result!='unknown_retention_passed':raise RuntimeError('Unexpected unknown retention receipt')
receipt={'passed':True,'checks':['1001 expired unknown cursors require two bounded calls','active cursor preserved','seven-day grace cursor preserved','probe entirely rolled back']}
(P/'unknown-retention-evidence.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
