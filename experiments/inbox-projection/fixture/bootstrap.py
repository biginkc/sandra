"""Source-only bootstrap. Refuses any target except the fixed disposable T2 container."""
from pathlib import Path
import subprocess,json,hashlib,re,sys
from transaction_envelope import normalize
from guards import validate_container, validate_digest, validate_cron
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
HOST='unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'
CONTAINER='sandra-inbox-projection-t2-db'
ID='603c10117cb7ef6a07d81448dd1a25b0c1ee2787a59f75871015c4a416cac557'
DOCKER=['docker','--host',HOST]
def sql(text):
 return subprocess.run(DOCKER+['exec','-i',CONTAINER,'psql','-U','supabase_admin','-d','postgres','-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],input=text,text=True,capture_output=True)
def checked(text):
 r=sql(text)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def guard():
 d=json.loads(subprocess.check_output(DOCKER+['inspect',CONTAINER],text=True))[0]
 validate_container(d)
 validate_cron(checked('show cron.launch_active_jobs;'))
guard()
checked((HERE/'correct-owner.sql').read_text())
checked('CREATE SCHEMA IF NOT EXISTS t2_fixture; CREATE TABLE IF NOT EXISTS t2_fixture.bootstrap_ledger(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now()); GRANT USAGE ON SCHEMA t2_fixture TO postgres; GRANT SELECT,INSERT ON t2_fixture.bootstrap_ledger TO postgres;')
manifest=json.loads((HERE/'vendor/manifest.json').read_text())
files=[]
for entry in manifest:
 p=HERE/'vendor'/entry['file'];raw=p.read_text();validate_digest(hashlib.sha256(p.read_bytes()).hexdigest(),entry['sha256'],p.name)
 if 'auth' in entry['url']:raw=raw.replace('{{ index .Options "Namespace" }}','auth')
 files.append(('vendor/'+p.name,raw,entry['sha256']))
for p in sorted((ROOT/'supabase/migrations').glob('*.sql')):
 raw=p.read_text();files.append((p.name,raw,hashlib.sha256(p.read_bytes()).hexdigest()))
results=[]
for name,raw,digest in files:
 guard()
 recorded=checked("SELECT sha256 FROM t2_fixture.bootstrap_ledger WHERE name='"+name+"';")
 if recorded:
  validate_digest(recorded,digest,'previously applied '+name)
  results.append({'name':name,'status':'already_applied','sha256':digest});continue
 # Standalone transaction envelopes in source are removed so body + ledger commit atomically.
 # PL/pgSQL BEGIN blocks have no semicolon; do not remove those.
 body,n=normalize(raw)
 if re.search(r'(?im)^\s*(?:begin transaction|start transaction|commit transaction|end transaction)\b',body):raise RuntimeError('Unsupported transaction envelope: '+name)
 role="SET LOCAL ROLE postgres; " if not name.startswith('vendor/') else ''
 statement="BEGIN; "+role+"SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='5s'; SET LOCAL storage.install_roles='false';\n"+body+"\nINSERT INTO t2_fixture.bootstrap_ledger(name,sha256) VALUES ('"+name+"','"+digest+"'); COMMIT;"
 r=sql(statement)
 row={'name':name,'status':'applied' if r.returncode==0 else 'failed','sha256':digest,'removed_transaction_envelope_lines':n}
 if r.returncode:row['error']=r.stderr[-7000:]
 results.append(row)
 with (HERE/'attempts.jsonl').open('a') as log: log.write(json.dumps(row)+'\n')
 (HERE/'bootstrap-result.json').write_text(json.dumps({'container':CONTAINER,'source_revision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'results':results,'complete':r.returncode==0 and len(results)==len(files)},indent=2))
 if r.returncode:print(json.dumps(row,indent=2));sys.exit(1)
 print(name,flush=True)
guard()
checked("BEGIN;\n"+(HERE/'vendor-owner-finalization.sql').read_text()+"\nCOMMIT;")
checked("CREATE SCHEMA IF NOT EXISTS inbox_t2_fixture; CREATE TABLE IF NOT EXISTS inbox_t2_fixture.identity(marker text PRIMARY KEY); INSERT INTO inbox_t2_fixture.identity VALUES ('sandra-inbox-projection-t2-owned-synthetic') ON CONFLICT DO NOTHING; GRANT USAGE ON SCHEMA inbox_t2_fixture TO postgres; GRANT SELECT ON inbox_t2_fixture.identity TO postgres;")
final={'status':'ready','complete':True,'container':CONTAINER,'containerId':ID,'database':'postgres','applicationRole':'postgres','network':'none','cron_launch_active_jobs':'off','source_revision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'source_migrations':len([r for r in results if not r['name'].startswith('vendor/')]),'results':results}
(HERE/'bootstrap-result.json').write_text(json.dumps(final,indent=2))
print('BOOTSTRAP_COMPLETE',len(results))
