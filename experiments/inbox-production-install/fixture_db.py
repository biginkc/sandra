"""Connection guard shared by candidate fixture tests; never accepts a remote DSN."""
import json,os,subprocess,sys,time
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection/fixture'));from guards import validate_container,validate_cron
SOCKET=os.environ.get('INBOX_T2_DOCKER_SOCKET','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock')
D=['docker','--host',SOCKET];N='sandra-inbox-projection-t2-db'
# Do not silently retarget the backend-owned install database.  The release
# harness can select only the explicitly dedicated database after ownership
# has been confirmed and the marker has been installed.
DB=os.environ.get('INBOX_RELEASE_DATABASE','sandra_inbox_install_20260913')
if DB not in {'sandra_inbox_install_20260913','sandra_inbox_release_20260917'}:
    raise RuntimeError('Refusing unapproved candidate database: '+DB)
EXPECTED_MARKER=os.environ.get('INBOX_RELEASE_FIXTURE_MARKER','sandra-inbox-production-candidate-owned-synthetic')
def sql(q,role='postgres',retry=False):
 for attempt in range(3 if retry else 1):
  r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U',role,'-d',DB,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],input="SET statement_timeout='30s';SET lock_timeout='2s';"+q,text=True,capture_output=True,timeout=40)
  if not r.returncode:return r.stdout.strip()
  if not retry or not any(code in r.stderr for code in ['40P01','40001','55P03']) or attempt==2:raise RuntimeError(r.stderr)
  time.sleep(0.05*(attempt+1)) # retry the entire failed transaction only

def guard():
 validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
 validate_cron(sql('SHOW cron.launch_active_jobs',role='supabase_admin'))
 if sql('SELECT marker FROM install_fixture.identity',role='supabase_admin')!=EXPECTED_MARKER:raise RuntimeError('Wrong candidate fixture marker')
def literal(value):return "'"+str(value).replace("'","''")+"'"

def ensure_concurrent_index(q):
 """Strict comparison for this bundle's pinned simple btree index statements."""
 import re
 match=re.match(r'CREATE INDEX CONCURRENTLY (\w+) ON public\.',q)
 if not match:raise RuntimeError('Expected separately compiled canonical concurrent index')
 name=match.group(1)
 rows=json.loads(sql(f"SELECT coalesce(jsonb_agg(jsonb_build_object('valid',i.indisvalid,'ready',i.indisready,'definition',pg_get_indexdef(i.indexrelid))),'[]') FROM pg_index i WHERE i.indexrelid=to_regclass('public.{name}')"))
 if not rows:
  sql(q)
  return ensure_concurrent_index(q)
 def compact(value):return re.sub(r'[\s();]','',value.replace('CONCURRENTLY ','').replace(' USING btree ',' ').replace('::text',''))
 if len(rows)!=1 or not rows[0]['valid'] or not rows[0]['ready'] or compact(rows[0]['definition'])!=compact(q):raise RuntimeError('Invalid/different owned concurrent index: '+name)
 return name
