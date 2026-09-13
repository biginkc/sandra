#!/usr/bin/env python3
"""Create only the explicitly owned candidate projector role/container. No production DSN."""
import argparse,json,os,secrets,subprocess,sys,time
from pathlib import Path
P=Path(__file__).resolve().parent;ROOT=P.parent.parent;INSTALL=P.parent/'inbox-production-install'
sys.path.insert(0,str(INSTALL));from fixture_db import guard,sql,D,N,DB,literal
ap=argparse.ArgumentParser();ap.add_argument('--owned-fixture',action='store_true');a=ap.parse_args()
if not a.owned_fixture:raise SystemExit('Explicit owned fixture required')
guard();container='sandra-inbox-persistent-projector-20260913';login='inbox_projection_login_20260913';image='sandra-inbox-projection-worker:20260913'
if subprocess.run(D+['inspect',container],capture_output=True).returncode==0:raise RuntimeError('Owned projector already exists; inspect rather than replace it')
if sql(f"SELECT count(*) FROM pg_roles WHERE rolname='{login}'",role='supabase_admin')!='0':raise RuntimeError('Fixture login already exists; never reset its password')
sql((ROOT/'services/inbox-projection-worker/worker-role.sql').read_text(),role='supabase_admin')
password=secrets.token_urlsafe(48)
try:sql(f"CREATE ROLE {login} LOGIN PASSWORD {literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;GRANT inbox_projection_worker TO {login};",role='supabase_admin')
except Exception:raise RuntimeError('Fixture login provisioning failed; inspect without exposing SQL/password') from None
private=Path('/tmp/sandra-inbox-projection-runtime-20260913');private.mkdir(mode=0o700,exist_ok=True);os.chmod(private,0o700)
env=private/'worker.env';env.write_text(f'INBOX_PROJECTION_DATABASE_URL=postgresql://{login}:{password}@127.0.0.1:5432/{DB}\nINBOX_PROJECTION_EXPECT_DATABASE={DB}\nINBOX_PROJECTION_OWNED_FIXTURE_PLAINTEXT=true\nINBOX_PROJECTION_BATCH_SIZE=25\nINBOX_PROJECTION_IDLE_MS=1000\nINBOX_PROJECTION_BIND=127.0.0.1\n');os.chmod(env,0o600)
# Pause the earlier comparison runner, then prove it has no active child before
# starting the persistent client. Preserve the existing user-facing services.
(P/'pause').touch()
if (P/'runtime.pid').exists():
 pid=int((P/'runtime.pid').read_text());deadline=time.monotonic()+40
 while True:
  child=subprocess.run(['pgrep','-P',str(pid)],capture_output=True,text=True)
  if child.returncode!=0:break
  if time.monotonic()>deadline:raise RuntimeError('Prior projector step still active; no sidecar started')
  time.sleep(.1)
 time.sleep(2.1)
subprocess.run(D+['run','-d','--name',container,'--label','sandra.inbox.fixture=projection-worker-candidate','--network','container:'+N,'--memory','256m','--cpus','.5','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--cap-drop','ALL','--security-opt','no-new-privileges','--env-file',str(env),image],check=True,stdout=subprocess.DEVNULL)
health=None
for _ in range(30):
 r=subprocess.run(D+['exec',container,'node','--input-type=module','-e',"const r=await fetch('http://127.0.0.1:9081/health');console.log(await r.text());process.exit(r.ok?0:1)"],text=True,capture_output=True)
 if not r.returncode:health=json.loads(r.stdout);break
 time.sleep(.2)
if not health:raise RuntimeError('Persistent projector not healthy; old runner remains paused for investigation')
activity=json.loads(sql("SELECT jsonb_build_object('connections',count(*),'backend_ids',jsonb_agg(pid)) FROM pg_stat_activity WHERE datname='sandra_inbox_install_20260913' AND application_name='sandra-inbox-projection'",role='supabase_admin'))
if activity['connections']!=1:raise RuntimeError('Projection pool exceeded one connection')
rights=json.loads(sql("SELECT jsonb_build_object('select_messages',has_table_privilege('inbox_projection_worker','public.messages','SELECT'),'update_messages',has_table_privilege('inbox_projection_worker','public.messages','UPDATE'),'read_auth',has_table_privilege('inbox_projection_worker','auth.sessions','SELECT'),'modify_control',has_table_privilege('inbox_projection_worker','inbox_control.rollout','UPDATE'))"))
if any(rights.values()):raise RuntimeError('Projection worker has unexpected direct canonical access')
receipt={'running':True,'container':container,'database':DB,'pool':activity,'health':health,'direct_privileges':rights,'memory_bytes':268435456,'cpu_limit':.5,'scope':'Owned isolated candidate sidecar; no production deployment, original comparison runner paused'}
(P/'persistent-evidence.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
