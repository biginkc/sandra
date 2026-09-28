#!/usr/bin/env python3
"""Install or resume concurrent indexes in the marked candidate fixture only."""
import argparse,hashlib,json,os,re,subprocess,time
from pathlib import Path
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--owned-fixture',action='store_true');ap.add_argument('--indexes-only',action='store_true');ap.add_argument('--rollback-probe',action='store_true');ap.add_argument('--target',choices=('release-db','http'),default=os.environ.get('INBOX_RELEASE_TARGET_PROFILE','release-db'));a=ap.parse_args()
if not a.owned_fixture:raise SystemExit('Explicit owned fixture required')
if a.target=='http':
 from http_fixture_db import DATABASE,MARKER,guard,sql,ensure_concurrent_index
else:
 from fixture_db import DB as DATABASE,EXPECTED_MARKER as MARKER,guard,sql,ensure_concurrent_index
guard();subprocess.run([__import__('sys').executable,str(P/'build.py')],check=True)
installed=sql("SELECT to_regnamespace('inbox_control') IS NOT NULL")=='t'
if not a.indexes_only:
 if installed:raise RuntimeError('Candidate exists; do not reset. Use explicit index resume or reviewed forward change')
 candidate=(P/'generated/install-candidate.sql').read_text()
 if a.rollback_probe:
  before=sql("SELECT coalesce(jsonb_agg(pg_get_triggerdef(oid) ORDER BY tgname),'[]') FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND NOT tgisinternal")
  probe=candidate.removesuffix('COMMIT;\n')+"DO $$ BEGIN RAISE EXCEPTION 'INBOX_REHEARSAL_ROLLBACK';END $$;COMMIT;"
  try:sql(probe)
  except RuntimeError as e:
   if 'INBOX_REHEARSAL_ROLLBACK' not in str(e):raise
  else:raise RuntimeError('Late failure probe unexpectedly committed')
  after=sql("SELECT coalesce(jsonb_agg(pg_get_triggerdef(oid) ORDER BY tgname),'[]') FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND NOT tgisinternal")
  if after!=before or sql("SELECT to_regnamespace('inbox_control') IS NULL AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='messages' AND column_name='inbox_inbound_revision')")!='t':raise RuntimeError('Atomic foundation rollback failed')
 started=time.monotonic();sql(candidate);elapsed=time.monotonic()-started
else:
 if not installed:raise RuntimeError('Candidate missing; index resume never installs foundation')
 elapsed=None
if sql('SELECT serving_enabled FROM inbox_control.rollout WHERE singleton')!='f':raise RuntimeError('Serving must remain disabled')
indexes=[]
for f in sorted((P/'generated').glob('index-*.sql')):
 q=f.read_text();name=re.search(r'CREATE INDEX CONCURRENTLY (\w+)',q).group(1)
 existing=sql(f"SELECT coalesce(jsonb_agg(jsonb_build_object('valid',i.indisvalid,'ready',i.indisready,'definition',pg_get_indexdef(i.indexrelid))),'[]') FROM pg_index i WHERE i.indexrelid=to_regclass('public.{name}')")
 rows=json.loads(existing)
 expected=re.sub(r'ON (public\.\w+)\(',r'ON \1 USING btree (',q.replace('CONCURRENTLY ','')).strip().rstrip(';')
 if rows:
  actual=rows[0]
  compact=lambda x:re.sub(r'\s+','',x)
  if not actual['valid'] or not actual['ready'] or compact(actual['definition'])!=compact(expected):raise RuntimeError('Existing invalid/different owned index: '+name+'; reviewed repair required')
 else:sql(q)
 indexes.append(name)
# Deferred historical validation after the installation transaction released its source locks.
sql('ALTER TABLE public.messages VALIDATE CONSTRAINT messages_inbox_inbound_revision_nonnegative')
try:sql("SELECT public.inbox_authorize_sync(NULL)")
except RuntimeError as e:
 if 'INBOX_NOT_READY' not in str(e):raise
else:raise RuntimeError('Disabled API unexpectedly served')
if sql("SELECT relreplident FROM pg_class WHERE oid='inbox_bridge.summaries'::regclass")!='f':raise RuntimeError('Narrow DTO lacks REPLICA IDENTITY FULL')
(P/'install-evidence.json').write_text(json.dumps({'installed':True,'atomic_late_failure_probe':a.rollback_probe,'serving_enabled':False,'target_profile':a.target,'database':DATABASE,'marker':MARKER,'foundation_wall_seconds':elapsed,'concurrent_indexes':indexes,'source_sha256':hashlib.sha256((P/'generated/install-candidate.sql').read_bytes()).hexdigest(),'scope':'Owned new DB only; not production lock/performance acceptance'},indent=2)+'\n')
print('Candidate installed, indexes valid, APIs disabled')
