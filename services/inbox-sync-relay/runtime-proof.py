"""Explicitly owned T1 proof: built relay -> pinned Electric -> synthetic projection."""
import hashlib,http.client,json,secrets,subprocess,time,urllib.request,urllib.error,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
def docker(*args):return subprocess.check_output(D+list(args),text=True).strip()
def need(value,label):
 if not value:raise RuntimeError(label)
def sql(q):return docker('exec','sandra-inbox-stack-db','psql','-U','postgres','-d','sandra_inbox_t1','-XqAt','-v','ON_ERROR_STOP=1','-c',q)
need(sql("SELECT current_database()||'|'||marker FROM inbox_t1.fixture_identity")=='sandra_inbox_t1|sandra-inbox-stack-t1-owned-synthetic','Wrong T1 database')
electric=json.loads(docker('inspect','sandra-inbox-stack-electric'))[0]
need(electric['Id']=='ede8887c1b120d49bca326f3909af58af47b362f58ba9f7cae0f719bf898de8c','Unexpected Electric owner')
need(electric['Config']['Image']=='electricsql/electric:1.8.1@sha256:efb6fa43859d67cb8c73439e0c8bc0f7a3daa467500fb06f2a924bcb2070c139','Unexpected Electric image')
need(electric['State']['Running'],'Electric stopped')
net=electric['NetworkSettings']['Networks'];need(set(net)=={'sandra-inbox-stack-t1'},'Wrong Electric network')
image=json.loads(docker('image','inspect','sandra-inbox-sync-relay:20260913'))[0]
need(image['Config']['Labels']['com.bmh.inbox-fixture']=='sandra-inbox-hosting-candidate-owned','Wrong relay image owner')
suffix=uuid.uuid4().hex[:12];schema='inbox_relay_'+suffix;container='sandra-inbox-relay-proof-'+suffix
o,c=str(uuid.uuid4()),str(uuid.uuid4());token=secrets.token_urlsafe(40);cid=None;electric_id=None
stream='relay_'+suffix;publication='electric_publication_'+stream;slot='electric_slot_'+stream
try:
 sql(f"CREATE SCHEMA {schema};CREATE TABLE {schema}.projection(org_id uuid NOT NULL,target_kind text NOT NULL,target_id uuid NOT NULL,name text,context text,preview text,time_label text,outcome_label text,assigned_label text,unread boolean,PRIMARY KEY(org_id,target_kind,target_id));ALTER TABLE {schema}.projection REPLICA IDENTITY FULL;INSERT INTO {schema}.projection VALUES('{o}','known_conversation','{c}','Synthetic relay proof','Owned','Hello','Now','None','Unassigned',true);")
 electric_id=docker('run','-d','--name','sandra-inbox-relay-electric-'+suffix,'--label','com.bmh.inbox-fixture=sandra-inbox-hosting-candidate-owned','--network','sandra-inbox-stack-t1','--memory','512m','--cpus','1','-e','DATABASE_URL=postgres://postgres:postgres@sandra-inbox-stack-db:5432/sandra_inbox_t1?sslmode=disable','-e','ELECTRIC_INSECURE=true','-e','ELECTRIC_DB_POOL_SIZE=2','-e','ELECTRIC_MANUAL_TABLE_PUBLISHING=true','-e','ELECTRIC_REPLICATION_STREAM_ID='+stream,'-e','ELECTRIC_LONG_POLL_TIMEOUT=8000','-e','ELECTRIC_TELEMETRY=false',electric['Config']['Image'])
 for _ in range(40):
  if sql(f"SELECT EXISTS(SELECT 1 FROM pg_publication WHERE pubname='{publication}')")=='t':break
  time.sleep(.25)
 else:raise RuntimeError('Dedicated Electric publication unavailable')
 sql(f'ALTER PUBLICATION {publication} ADD TABLE {schema}.projection;')
 electric_ip=json.loads(docker('inspect',electric_id))[0]['NetworkSettings']['Networks']['sandra-inbox-stack-t1']['IPAddress']
 cid=docker('run' ,'-d','--name',container,'--label','com.bmh.inbox-fixture=sandra-inbox-hosting-candidate-owned','--network','sandra-inbox-stack-t1','--add-host','inbox-electric.railway.internal:'+electric_ip,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--cpus','0.5','-p','127.0.0.1::3000','-e','INBOX_RELAY_UPSTREAM=http://inbox-electric.railway.internal:3000/','-e','INBOX_RELAY_TOKEN='+token,'-e','INBOX_RELAY_PROJECTION_TABLE='+schema+'.projection',image['Id'])
 state=json.loads(docker('inspect',cid))[0];port=state['NetworkSettings']['Ports']['3000/tcp'][0]
 need(port['HostIp']=='127.0.0.1' and state['Config']['User']=='node','Unsafe relay binding/user')
 base='http://127.0.0.1:'+port['HostPort']
 def request(path,authorized=True):
  r=urllib.request.Request(base+path,headers={'Authorization':'Bearer '+token} if authorized else {})
  try:
   with urllib.request.urlopen(r,timeout=16) as response:return response.status,dict(response.headers),response.read()
  except urllib.error.HTTPError as error:return error.code,dict(error.headers),error.read()
 for _ in range(20):
  try:
   if request('/health',False)[0]==200:break
  except (urllib.error.URLError,http.client.HTTPException):pass
  time.sleep(.25)
 else:raise RuntimeError('Relay readiness failed')
 from urllib.parse import urlencode
 query=urlencode({'table':schema+'.projection','columns':'org_id,target_kind,target_id,name,context,preview,time_label,outcome_label,assigned_label,unread','replica':'default','offset':'-1','where':'org_id=$1','params[1]':o})
 need(request('/v1/shape?'+query,False)[0]==401,'Unauthenticated relay request admitted')
 status,headers,body=request('/v1/shape?'+query)
 need(status==200,'Real shape status '+str(status)+': '+body.decode()[:200])
 messages=json.loads(body);rows=[m['value'] for m in messages if m.get('headers',{}).get('operation')=='insert']
 need(len(rows)==1 and rows[0]['org_id']==o and rows[0]['target_id']==c,'Wrong synthetic row')
 need(token.encode() not in body,'Secret leaked')
 lower_headers={key.lower():value for key,value in headers.items()}
 from urllib.parse import parse_qs
 polling=parse_qs(query);polling={key:values[0] for key,values in polling.items()};polling.update({'offset':lower_headers['electric-offset'],'handle':lower_headers['electric-handle'],'live':'true'})
 began=time.monotonic();quiet_status,_,quiet_body=request('/v1/shape?'+urlencode(polling));elapsed=time.monotonic()-began
 need(quiet_status in [200,204] and 6.5<elapsed<12,'Idle long-poll timeout mismatch: '+str((quiet_status,elapsed)))
 result={'checks':['built nonroot/read-only/capped relay reaches actual pinned Electric readiness','unauthenticated real shape request denied','authenticated actual Electric shape returns exact owned canonical projection row','configured8000ms idle poll completes below relay14s deadline'],'image_id':image['Id'],'node_version':docker('exec',cid,'node','--version'),'source_sha256':hashlib.sha256((P/'server.mjs').read_bytes()).hexdigest(),'dockerfile_sha256':hashlib.sha256((P/'Dockerfile').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'rows':rows,'idle_poll_seconds':round(elapsed,3),'idle_poll_status':quiet_status,'limits':['owned T1 fixture only; no Railway provision or production proof','no end-to-end browser latency claim']}
finally:
 if cid:
  state=json.loads(docker('inspect',cid))[0]
  need(state['Name']=='/'+container and state['Config']['Labels']['com.bmh.inbox-fixture']=='sandra-inbox-hosting-candidate-owned','Cleanup identity changed')
  docker('stop','-t','2',cid);docker('rm',cid)
 if electric_id:
  state=json.loads(docker('inspect',electric_id))[0]
  need(state['Name']=='/sandra-inbox-relay-electric-'+suffix and state['Config']['Labels']['com.bmh.inbox-fixture']=='sandra-inbox-hosting-candidate-owned','Electric cleanup identity changed')
  docker('stop','-t','2',electric_id);docker('rm',electric_id)
  sql(f"SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name='{slot}' AND database=current_database() AND NOT active;")
  sql(f'DROP PUBLICATION IF EXISTS {publication};')
  need(sql(f"SELECT count(*) FROM pg_replication_slots WHERE slot_name='{slot}'")=='0','Temporary slot remained')
 if sql(f"SELECT to_regclass('{schema}.projection') IS NOT NULL")=='t':
  need(sql(f"SELECT count(*)=1 AND bool_and(org_id='{o}'::uuid) FROM {schema}.projection")=='t','Cleanup rows changed')
  sql(f'DROP TABLE {schema}.projection;DROP SCHEMA {schema};')
result['cleanup']='Exact owned relay/Electric containers, slot/publication and synthetic table/schema removed; existing Electric and DB preserved'
(P/'runtime-evidence.json').write_text(json.dumps(result,indent=2)+'\n');print('Four built relay/real Electric runtime groups passed; owned cleanup verified')
