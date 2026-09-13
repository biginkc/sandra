#!/usr/bin/env bash
set -euo pipefail
# --inspect-only proves ownership/configuration without creating, starting or registering.
python3 - "${1:-}" <<'PY'
import json, subprocess, sys
HOST='unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'
NAME='sandra-inbox-stack-restate'
NETWORK='sandra-inbox-stack-t1'
IMAGE='docker.restate.dev/restatedev/restate@sha256:675b85e7bf674f9dfda04a391fa33e850650d57e464b694ca8df5866acad95cc'
DIGEST=IMAGE.split('@')[1]
LABEL='sandra-inbox-stack-t1-owned-synthetic'
LEGACY='cbd43bb3cfba877dbaf7c2d467f97a582b0ea24480a608c1160c76e7110cc3cb'
VOLUME='sandra-inbox-stack-t1-restate'
PORTS={'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':'58785'}], '9070/tcp':[{'HostIp':'127.0.0.1','HostPort':'58786'}]}
ENV={'RESTATE_CLUSTER_NAME':'sandra-inbox-stack-t1','RESTATE_AUTO_PROVISION':'true'}
inspect_only=sys.argv[1]=='--inspect-only'
if sys.argv[1] not in ('','--inspect-only'):raise SystemExit('Only --inspect-only is supported')
def docker(*args,check=True):
 return subprocess.run(['docker','--host',HOST,*args],text=True,capture_output=True,check=check)
marker=docker('exec','sandra-inbox-stack-db','psql','-U','postgres','-d','sandra_inbox_t1','-At','-v','ON_ERROR_STOP=1','-c','select current_database() || chr(124) || marker from inbox_t1.fixture_identity').stdout.strip()
if marker!='sandra_inbox_t1|'+LABEL:raise SystemExit('Refusing non-fixture database')
docker('network','inspect',NETWORK)
existing=docker('container','inspect',NAME,check=False)
if existing.returncode==0:
 c=json.loads(existing.stdout)[0]
 if (c['Config'].get('Labels') or {}).get('com.bmh.inbox-fixture')!=LABEL and c['Id']!=LEGACY:raise SystemExit('Refusing unknown container ownership')
 if c['Name']!='/'+NAME or c['Config']['Image']!=IMAGE:raise SystemExit('Refusing container/image reference mismatch')
 images=json.loads(docker('image','inspect',c['Image']).stdout)
 if not any(x.endswith('@'+DIGEST) for x in images[0].get('RepoDigests',[])):raise SystemExit('Refusing digest mismatch')
 hc=c['HostConfig']
 if hc['Memory']!=512*1024*1024 or hc.get('Privileged') or hc.get('PublishAllPorts'):raise SystemExit('Refusing resource/security mismatch')
 if hc['PortBindings']!=PORTS or c['NetworkSettings']['Ports']!=PORTS:raise SystemExit('Refusing loopback port mismatch')
 if hc['NetworkMode']!=NETWORK or set(c['NetworkSettings']['Networks'])!={NETWORK}:raise SystemExit('Refusing network mismatch')
 mounts=c['Mounts']
 if len(mounts)!=1 or mounts[0]['Type']!='volume' or mounts[0].get('Name')!=VOLUME or mounts[0]['Destination']!='/restate-data' or not mounts[0]['RW']:raise SystemExit('Refusing persistent volume mismatch')
 configured=dict(x.split('=',1) for x in c['Config']['Env'])
 if any(configured.get(k)!=v for k,v in ENV.items()):raise SystemExit('Refusing runtime config mismatch')
 if not c['State']['Running'] or c['State']['Paused'] or c['State']['Restarting'] or c['State']['OOMKilled']:raise SystemExit('Owned runtime is not healthy/running; inspect before any restart')
 print('Verified running owned Restate identity, digest, network, loopback ports,512MiB and persistent volume')
else:
 names=docker('ps','-a','--format','{{.Names}}').stdout.splitlines()
 if NAME in names:raise SystemExit('Container inspect failed; refusing creation')
 if inspect_only:raise SystemExit('Owned runtime absent; inspect-only cannot create')
 docker('pull',IMAGE)
 args=['run','-d','--name',NAME,'--label','com.bmh.inbox-fixture='+LABEL,'--network',NETWORK,'--memory','512m','-p','127.0.0.1:58785:8080','-p','127.0.0.1:58786:9070','-v',VOLUME+':/restate-data']
 for k,v in ENV.items():args+=['-e',k+'='+v]
 docker(*args,IMAGE)
 print('Created pinned labeled Restate runtime; worker registration follows')
if not inspect_only:
 subprocess.run(['curl','--retry','10','--retry-connrefused','--retry-delay','1','--fail','--silent','--show-error','-X','POST','http://127.0.0.1:58786/deployments','-H','content-type: application/json','-d','{"uri":"http://host.lima.internal:58788","use_http_11":true}'],check=True)
PY
