#!/usr/bin/env python3
"""Install candidate and backfill only owned corpus rows with source-row fencing."""
import json,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input="SET statement_timeout='30s';SET lock_timeout='2s';"+q,text=True,capture_output=True,timeout=40)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong fixture')
if sql("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='inbox_t2_bridge' AND table_name='filter_rows' AND column_name='outreach_dispo')")=='t':raise RuntimeError('Already installed')
sql((P/'setup.sql').read_text())
cursor=None;count=0
while True:
 predicate='' if cursor is None else f"WHERE (org_id,target_kind,target_id)>('{cursor['org']}'::uuid,'{cursor['kind']}','{cursor['id']}'::uuid)"
 rows=json.loads(sql(f"""WITH locked AS MATERIALIZED(SELECT * FROM inbox_t2_maintained.rows {predicate} ORDER BY org_id,target_kind,target_id LIMIT 1000 FOR SHARE),
 applied AS(UPDATE inbox_t2_bridge.filter_rows r SET outreach_dispo=l.summary->>'outreach_dispo' FROM locked l WHERE (r.org_id,r.target_kind,r.target_id)=(l.org_id,l.target_kind,l.target_id) AND r.revision<=l.revision RETURNING r.target_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('org',org_id,'kind',target_kind,'id',target_id) ORDER BY org_id,target_kind,target_id),'[]') FROM locked"""))
 if not rows:break
 count+=len(rows);cursor=rows[-1]
print(f'Outcome backfill examined {count} locked source rows')
