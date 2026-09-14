#!/usr/bin/env bash
set -euo pipefail
# Only the disposable Inbox T1 stack. Never changes the default Docker context.
python3 - <<'PY'
import json, subprocess, time
HOST='unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'
NAME='sandra-inbox-stack-electric'
NETWORK='sandra-inbox-stack-t1'
IMAGE='electricsql/electric:1.8.1@sha256:efb6fa43859d67cb8c73439e0c8bc0f7a3daa467500fb06f2a924bcb2070c139'
DIGEST=IMAGE.split('@')[1]
LABEL='sandra-inbox-stack-t1-owned-synthetic'
# Exact first owned instance predates labels. No other unlabeled container is reusable.
LEGACY='ede8887c1b120d49bca326f3909af58af47b362f58ba9f7cae0f719bf898de8c'
env={
 'DATABASE_URL':'postgres://postgres:postgres@sandra-inbox-stack-db:5432/sandra_inbox_t1?sslmode=disable',
 'ELECTRIC_INSECURE':'true','ELECTRIC_DB_POOL_SIZE':'2',
 'ELECTRIC_MANUAL_TABLE_PUBLISHING':'true','ELECTRIC_REPLICATION_STREAM_ID':'inbox_t1',
 'ELECTRIC_MAX_SHAPES':'16','ELECTRIC_TELEMETRY':'false','ELECTRIC_LOG_LEVEL':'warning',
}
def docker(*args,check=True):
 return subprocess.run(['docker','--host',HOST,*args],text=True,capture_output=True,check=check)
def sql(query,check=True):
 return docker('exec','sandra-inbox-stack-db','psql','-U','postgres','-d','sandra_inbox_t1','-At','-v','ON_ERROR_STOP=1','-c',query,check=check)
marker=sql('select current_database() || chr(124) || marker from inbox_t1.fixture_identity').stdout.strip()
if marker!='sandra_inbox_t1|'+LABEL: raise SystemExit('Refusing non-fixture database')
docker('network','inspect',NETWORK)
existing=docker('container','inspect',NAME,check=False)
if existing.returncode==0:
 c=json.loads(existing.stdout)[0]
 labels=c['Config'].get('Labels') or {}
 if labels.get('com.bmh.inbox-fixture')!=LABEL and c['Id']!=LEGACY:
  raise SystemExit('Refusing unknown container ownership')
 if c['Config']['Image']!=IMAGE: raise SystemExit('Refusing different image reference')
 images=json.loads(docker('image','inspect',c['Image']).stdout)
 if not any(x.endswith('@'+DIGEST) for x in images[0].get('RepoDigests',[])):
  raise SystemExit('Refusing image digest mismatch')
 configured=dict(x.split('=',1) for x in c['Config']['Env'])
 if any(configured.get(k)!=v for k,v in env.items()): raise SystemExit('Refusing configuration mismatch')
 hc=c['HostConfig']
 if hc['Memory']!=512*1024*1024 or hc['NanoCpus']!=1_000_000_000: raise SystemExit('Refusing resource-cap mismatch')
 if hc['PortBindings']!={'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':'58783'}]}: raise SystemExit('Refusing port mismatch')
 if set(c['NetworkSettings']['Networks'])!={NETWORK}: raise SystemExit('Refusing network mismatch')
 if not c['State']['Running']: docker('start',NAME)
 print('Reusing exact owned Electric instance')
else:
 # Container absence is verified separately; daemon failure must not imply permission to create.
 names=docker('ps','-a','--format','{{.Names}}').stdout.splitlines()
 if NAME in names: raise SystemExit('Container inspect failed; not creating')
 docker('pull',IMAGE)
 args=['run','-d','--name',NAME,'--label','com.bmh.inbox-fixture='+LABEL,
       '--network',NETWORK,'--memory','512m','--cpus','1','-p','127.0.0.1:58783:3000']
 for k,v in env.items():args+=['-e',k+'='+v]
 docker(*args,IMAGE)
 print('Created pinned, labeled Electric instance')
for attempt in range(30):
 ready=sql("select 1 from pg_publication where pubname='electric_publication_inbox_t1'",check=False)
 if ready.returncode==0 and ready.stdout.strip()=='1':break
 time.sleep(.5)
else: raise SystemExit('Electric publication not ready after15seconds; inspect owned container logs')
sql("""DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='electric_publication_inbox_t1' AND schemaname='inbox_t1' AND tablename='conversation_summaries') THEN
 ALTER PUBLICATION electric_publication_inbox_t1 ADD TABLE inbox_t1.conversation_summaries;
 END IF;
END $$;""")
print('Ready: pinned Electric1.8.1 on127.0.0.1:58783, manual summary publication')
PY
