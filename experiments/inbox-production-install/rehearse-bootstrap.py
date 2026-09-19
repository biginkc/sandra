#!/usr/bin/env python3
"""Fresh canonical schema in a separate owned database; never recreates T2 or touches its postgres DB."""
from pathlib import Path
import argparse,hashlib,json,os,re,subprocess,sys
P=Path(__file__).resolve().parent;ROOT=P.parent.parent;F=P.parent/'inbox-projection/fixture'
sys.path.insert(0,str(F));from guards import validate_container,validate_cron
from transaction_envelope import normalize
ap=argparse.ArgumentParser();ap.add_argument('--resume-full-auth',action='store_true');a=ap.parse_args()
if not a.resume_full_auth:raise SystemExit('Explicit existing full-Auth fixture mode required')
SOCKET=os.environ.get('INBOX_T2_DOCKER_SOCKET','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock')
D=['docker','--host',SOCKET];N='sandra-inbox-projection-t2-db';DB='sandra_inbox_install_20260913';MARKER='sandra-inbox-production-candidate-owned-synthetic'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q,db=DB):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','supabase_admin','-d',db,'-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True,timeout=90)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
validate_cron(sql('SHOW cron.launch_active_jobs','postgres'))
if sql('SELECT marker FROM inbox_t2_fixture.identity','postgres')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong container database')
if sql(f"SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='{DB}')",'postgres')!='t':raise RuntimeError('Full Auth database missing; never create/reset automatically')
if sql('SELECT marker FROM install_fixture.identity')!=MARKER:raise RuntimeError('Wrong owned database')
if sql("SELECT to_regclass('auth.sessions') IS NOT NULL AND to_regclass('auth.schema_migrations') IS NOT NULL AND to_regclass('auth.flow_state') IS NOT NULL AND to_regclass('auth.one_time_tokens') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AND to_regprocedure('auth.jwt()') IS NOT NULL")!='t':raise RuntimeError('Expected real GoTrue Auth migrations, not subset')
sql('CREATE TABLE IF NOT EXISTS install_fixture.ledger(name text PRIMARY KEY,sha256 text NOT NULL)')
base="CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION postgres;CREATE SCHEMA IF NOT EXISTS realtime AUTHORIZATION postgres;CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\" WITH SCHEMA extensions;GRANT USAGE ON SCHEMA extensions TO postgres,anon,authenticated,service_role;"
foundation2="SET LOCAL ROLE postgres;CREATE PUBLICATION supabase_realtime;GRANT USAGE ON SCHEMA public TO postgres,anon,authenticated,service_role;ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres,anon,authenticated,service_role;ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres,anon,authenticated,service_role;ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres,anon,authenticated,service_role;RESET ROLE;"
files=[('fixture-platform-foundation',base,hashlib.sha256(base.encode()).hexdigest(),False),('fixture-platform-publication-grants',foundation2,hashlib.sha256(foundation2.encode()).hexdigest(),False)]
for entry in json.loads((F/'vendor/manifest.json').read_text()):
 f=F/'vendor'/entry['file'];text=f.read_text()
 if f.name in {'auth-jwt.sql','20210909172000_create_identities_table.up.sql','20230116124412_add_deleted_at.up.sql','20231117164230_add_id_pkey_identities.up.sql','20220224000811_update_auth_functions.up.sql'}:continue # preserve real GoTrue Auth and ownership
 if hashlib.sha256(f.read_bytes()).hexdigest()!=entry['sha256']:raise RuntimeError('Vendor hash changed '+f.name)
 if 'auth' in entry['url']:text=text.replace('{{ index .Options "Namespace" }}','auth')
 if f.name=='realtime-role.sql':
  if sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='supabase_realtime_admin') AND pg_has_role('postgres','supabase_realtime_admin','MEMBER')")!='t':raise RuntimeError('Expected existing image role membership')
  text='GRANT ALL PRIVILEGES ON SCHEMA realtime TO supabase_realtime_admin;'
 files.append(('vendor/'+f.name,text,hashlib.sha256(text.encode()).hexdigest(),False))
for f in sorted((ROOT/'supabase/migrations').glob('*.sql')):files.append((f.name,f.read_text(),hashlib.sha256(f.read_bytes()).hexdigest(),True))
results=[]
for name,raw,digest,app in files:
 recorded=sql(f"SELECT sha256 FROM install_fixture.ledger WHERE name='{name}'")
 if recorded:
  if recorded!=digest:raise RuntimeError('Previously applied source changed '+name)
  results.append({'name':name,'sha256':digest,'status':'already_applied'});continue
 body,_=normalize(raw)
 role='SET LOCAL ROLE postgres;' if app else ''
 # Ledger insert runs as the fixture admin after the application migration.
 sql("BEGIN;"+role+"SET LOCAL storage.install_roles='false';SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='2s';"+body+f"\nRESET ROLE;INSERT INTO install_fixture.ledger VALUES('{name}','{digest}');COMMIT;")
 results.append({'name':name,'sha256':digest,'status':'applied'});print(name,flush=True)
 (P/'bootstrap-progress.json').write_text(json.dumps(results,indent=2)+'\n')
sql('GRANT USAGE ON SCHEMA storage TO postgres,anon,authenticated,service_role;GRANT ALL ON storage.buckets,storage.objects TO anon,authenticated,service_role;')
(P/'bootstrap-evidence.json').write_text(json.dumps({'database':DB,'marker':MARKER,'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'results':results,'complete':True,'scope':'Separate canonical schema fixture; no customers/providers/copied rows'},indent=2)+'\n')
print('Owned candidate database bootstrap complete')
