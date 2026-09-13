#!/usr/bin/env python3
"""Start only a new signed Restate/worker pair in the fixed full-schema fixture."""
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,os,secrets,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent;sys.path.insert(0,str(P.parent/'inbox-projection/fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--start-owned']:raise SystemExit('Explicit --start-owned required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];DBCON='sandra-inbox-projection-t2-db';DB='sandra_inbox_action_runtime_20260913';MARKER='sandra-inbox-action-runtime-owned-synthetic';LABEL='sandra-inbox-action-worker-owned'
RESTATE='docker.restate.dev/restatedev/restate@sha256:675b85e7bf674f9dfda04a391fa33e850650d57e464b694ca8df5866acad95cc'
def run(args,input=None):
 r=subprocess.run(args,input=input,text=True,capture_output=True,timeout=40)
 if r.returncode:raise RuntimeError('Owned command failed: '+r.stderr[:1500])
 return r.stdout.strip()
def docker(*args):return run(D+list(args))
def sql(q):return run(D+['exec','-i',DBCON,'psql','-XqAt','-U','postgres','-d',DB,'-v','ON_ERROR_STOP=1'],q)
def need(v,msg):
 if not v:raise RuntimeError(msg)
state=json.loads(docker('inspect',DBCON))[0];validate_container(state);validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM install_fixture.identity')==MARKER,'Wrong canonical fixture marker')
need(sql('SELECT inbox_action_api.worker_readiness()')=='t','Baseline not ready')
need(sql('SELECT count(*) FROM inbox_operations.operations')=='0','Initial runtime must start before synthetic acceptance')
need(sql("SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname='inbox_action_worker'")=='t','Worker role absent/already active/unexpected')
local=P/'.runtime-local';local.mkdir(mode=0o700,exist_ok=True);os.chmod(local,0o700)
need(not(local/'state.json').exists(),'Owned runtime state exists; inspect/recover instead of creating again')
image=json.loads(docker('image','inspect','sandra-inbox-action-worker:20260913'))[0]
need(image['Config']['User']=='node' and image['Config']['Labels'].get('com.bmh.inbox-fixture')==LABEL,'Worker image identity')
ports=set()
for proc in ['/proc/net/tcp','/proc/net/tcp6']:
 for line in docker('exec',DBCON,'cat',proc).splitlines()[1:]:
  fields=line.split()
  if fields[3]=='0A':ports.add(int(fields[1].split(':')[1],16))
need(not(ports&{8080,9070,9080,5122}),'Runtime ports are already occupied')
suffix=uuid.uuid4().hex[:12];worker='sandra-inbox-action-worker-'+suffix;engine='sandra-inbox-action-restate-'+suffix;volume='sandra-inbox-action-restate-data-'+suffix
key=local/'private.pem';run(['openssl','genpkey','-algorithm','ed25519','-out',str(key)]);os.chmod(key,0o600)
raw=subprocess.check_output(['openssl','pkey','-in',str(key),'-pubout','-outform','DER'],stderr=subprocess.DEVNULL)[-32:]
alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';number=int.from_bytes(raw,'big');encoded=''
while number:number,remainder=divmod(number,58);encoded=alphabet[remainder]+encoded
encoded='1'*(len(raw)-len(raw.lstrip(b'\0')))+encoded;public='publickeyv1_'+encoded
hosts=local/'hosts';hosts.write_text('127.0.0.1 localhost sandra-inbox-actions-db-owned sandra-inbox-restate-owned\n::1 localhost\n');os.chmod(hosts,0o644)
password=secrets.token_urlsafe(40)
config={'NODE_ENV':'test','INBOX_ACTION_WORKER_ENABLED':'1','INBOX_ACTION_LOCAL_FIXTURE':'1','INBOX_ACTION_DATABASE_URL':f'postgres://inbox_action_worker:{password}@sandra-inbox-actions-db-owned:5432/{DB}','INBOX_RESTATE_INGRESS_URL':'http://sandra-inbox-restate-owned:8080/','INBOX_RESTATE_IDENTITY_KEYS':json.dumps([public]),'INBOX_ACTION_CONNECTIONS':'2'}
env=local/'worker.env';env.write_text(''.join(k+'='+v+'\n' for k,v in config.items()));os.chmod(env,0o600)
runtime={'database':DB,'marker':MARKER,'worker_name':worker,'engine_name':engine,'volume':volume,'public_key':public,'worker_image':image['Id'],'restate_image':RESTATE,'label':LABEL,'db_container_id':state['Id'],'phase':'prepared'}
def save():
 (local/'state.json').write_text(json.dumps(runtime,indent=2)+'\n');os.chmod(local/'state.json',0o600)
save()
# Role provisioning is confined to the new previously-NOLOGIN owned principal.
sql("ALTER ROLE inbox_action_worker LOGIN PASSWORD '"+password+"'")
runtime['role_password_fingerprint']=sql("SELECT encode(sha256(convert_to(rolpassword,'UTF8')),'hex') FROM pg_authid WHERE rolname='inbox_action_worker'");save()
docker('volume','create','--label','com.bmh.inbox-fixture='+LABEL,volume)
runtime['engine_id']=docker('run','-d','--name',engine,'--label','com.bmh.inbox-fixture='+LABEL,'--network','container:'+state['Id'],'--memory','512m','--cpus','1','--cap-drop','ALL','--security-opt','no-new-privileges','--mount','type=volume,source='+volume+',target=/restate-data','--mount','type=bind,source='+str(key)+',target=/restate-key.pem,readonly','-e','RESTATE_CLUSTER_NAME='+engine,'-e','RESTATE_AUTO_PROVISION=true','-e','RESTATE_REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE=/restate-key.pem',RESTATE);save()
runtime['worker_id']=docker('run','-d','--name',worker,'--label','com.bmh.inbox-fixture='+LABEL,'--network','container:'+state['Id'],'--memory','1g','--cpus','1','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--mount','type=bind,source='+str(hosts)+',target=/etc/hosts,readonly','--env-file',str(env),image['Id']);save()
for identifier in [runtime['worker_id'],runtime['engine_id']]:
 observed=json.loads(docker('inspect',identifier))[0]
 need(observed['HostConfig']['NetworkMode']=='container:'+state['Id'] and not observed['HostConfig'].get('PortBindings'),'Unexpected runtime exposure')
for _ in range(40):
 try:
  result=docker('exec',runtime['worker_id'],'node','--input-type=module','-e',"const r=await fetch('http://127.0.0.1:9070/health',{signal:AbortSignal.timeout(1500)});console.log(r.status)")
  if result=='200':break
 except RuntimeError:pass
 time.sleep(.25)
else:raise RuntimeError('Owned Restate admin did not become ready; preserve evidence and inspect')
registration=docker('exec',runtime['worker_id'],'node','--input-type=module','-e',"const r=await fetch('http://127.0.0.1:9070/deployments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uri:'http://127.0.0.1:9080',use_http_11:true}),signal:AbortSignal.timeout(10000)});console.log(JSON.stringify({status:r.status,body:await r.json()}));")
runtime['registration']=json.loads(registration);need(runtime['registration']['status'] in (200,201),'Signed service registration failed')
runtime['phase']='registered';save()
print('Owned signed worker/Restate pair registered; canonical effect/restart proof still required')
