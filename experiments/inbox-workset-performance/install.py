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
if sql("SELECT to_regclass('inbox_t2_bridge.filter_rows') IS NULL")!='t':raise RuntimeError('Already installed; preserve state')
sql((P/'typed-filters.sql').read_text())
for corpus in json.loads((P/'corpus.json').read_text()):
 o=corpus['org'];cursor=None;count=0
 while True:
  predicate='' if cursor is None else f"AND (target_kind,target_id)>('{cursor['kind']}','{cursor['id']}'::uuid)"
  rows=json.loads(sql(f"""WITH locked AS MATERIALIZED(SELECT * FROM inbox_t2_maintained.rows WHERE org_id='{o}' {predicate} ORDER BY target_kind,target_id LIMIT 1000 FOR SHARE),
 applied AS MATERIALIZED(SELECT target_kind,target_id,inbox_t2_bridge.upsert_filter(org_id,target_kind,target_id,revision,summary) FROM locked)
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',target_kind,'id',target_id) ORDER BY target_kind,target_id),'[]') FROM applied"""))
  if not rows:break
  count+=len(rows);cursor=rows[-1]
 if count!=corpus['size']:raise RuntimeError('Backfill count mismatch')
 print(f'Typed backfill {count} rows',flush=True)
sql('ANALYZE inbox_t2_bridge.filter_rows')
