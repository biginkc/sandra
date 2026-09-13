#!/usr/bin/env python3
"""Explicitly owned canonical SQL rehearsal, never a JWT verification claim."""
import json,subprocess,sys,uuid,hashlib
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q,ok=True):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input="SET statement_timeout='20s'; SET lock_timeout='2s';"+q,text=True,capture_output=True,timeout=30)
 if ok and r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip() if ok else r

def need(v,label):
 if not v:raise RuntimeError(label)
validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','marker')
need(sql("SELECT to_regnamespace('inbox_t2_bridge') IS NULL")=='t','Already installed; preserve evidence')
# auth is owned by the fixture auth administrator; grant only this new subset table.
need(sql("SELECT to_regclass('auth.sessions') IS NULL")=='t','Unexpected sessions table')
bootstrap="BEGIN; CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,not_after timestamptz); ALTER TABLE auth.sessions OWNER TO postgres; COMMIT;"
r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],input=bootstrap,text=True,capture_output=True,timeout=30)
need(r.returncode==0,r.stderr)
# Install all files atomically; embedded BEGIN/COMMIT removed for the outer transaction.
files=['projection.sql','auth.sql','worksets.sql','public-api.sql','parity-v2.sql']
sql('BEGIN;'+''.join((P/f).read_text().replace('BEGIN;\n','',1).rsplit('COMMIT;',1)[0] for f in files)+'COMMIT;')
(P/'install-evidence.json').write_text(json.dumps({'installed':True,'hashes':{f:hashlib.sha256((P/f).read_bytes()).hexdigest() for f in files}},indent=2)+'\n')
print('Owned canonical bridge installation passed')
