#!/usr/bin/env python3
"""Owned canonical SQL behavior tests; claims are not a JWT transport proof."""
import hashlib,json,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def need(v,label):
 if not v:raise RuntimeError(label)
def sql(q,allow_error=False):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],input="SET statement_timeout='15s';SET lock_timeout='2s';"+q,text=True,capture_output=True,timeout=25)
 if not allow_error:need(r.returncode==0,r.stderr)
 return r if allow_error else r.stdout.strip()
validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture')

import re
source=(P/'public-api.sql').read_text()
for name,args,body in re.findall(r'CREATE FUNCTION public\.(\w+)\((.*?)\) RETURNS jsonb.*?AS \$\$(.*?)\$\$;',source,re.S):
 signature=','.join(arg.strip().split()[-1] for arg in args.split(','))
 need(sql(f"SELECT prosrc FROM pg_proc WHERE oid='public.{name}({signature})'::regprocedure")==body.strip(),'Installed wrapper source differs: '+name)
o,u,owner,session,conversation,inbound,outbound,outbound_null=[str(uuid.uuid4()) for _ in range(8)]
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Wrapper {o}');INSERT INTO auth.users(id) VALUES('{owner}'),('{u}');INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{owner}','{o}','owner','active'),('{u}','{o}','member','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{session}','{u}',clock_timestamp()+interval '1 hour');INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body) VALUES('{inbound}','{o}','{conversation}','sms','inbound','received','Synthetic inbound'),('{outbound}','{o}','{conversation}','sms','outbound','sent','Synthetic outbound');COMMIT;")
null_attempt=sql(f"INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body,inbox_inbound_revision) VALUES('{outbound_null}','{o}','{conversation}','sms','outbound','sent','Synthetic explicit-null outbound',NULL)",True)
need(null_attempt.returncode!=0 and 'INBOX_REVISION_SERVER_OWNED' in null_attempt.stderr,'Explicit null revision was not rejected')
claims=json.dumps({'sub':u,'role':'authenticated','session_id':session,'exp':4102444800})
auth="SET request.jwt.claims='"+claims+"';SET ROLE authenticated;"
detail=json.loads(sql(auth+f"SELECT public.inbox_read_detail('{o}','{conversation}')"))
need(len(detail['history'])==2,'Mixed history missing')
by_id={row['id']:row for row in detail['history']}
need(by_id[outbound]['inbound_revision']=='0','Default outbound baseline differs')
need(isinstance(by_id[inbound]['inbound_revision'],str) and int(by_id[inbound]['inbound_revision'])>0,'Inbound revision absent')
boundary=detail['read_boundary'];ack=json.loads(sql(auth+f"SELECT public.inbox_acknowledge_read('{boundary}',0)"))
need(ack['changed']==1 and ack['completed'],'Public read acknowledgment wrong')
need(sql(f"SELECT read_at IS NULL FROM messages WHERE id='{outbound}'")=='t','Outbound acknowledged')
for role in ['anon','service_role']:
 for call in [f"public.inbox_read_detail('{o}','{conversation}')",f"public.inbox_acknowledge_read('{boundary}',0)"]:
  denied=sql(f"SET ROLE {role};SELECT {call}",True)
  need(denied.returncode!=0 and 'ERROR:  42501:' in denied.stderr and 'permission denied for function' in denied.stderr,'Direct role execute not denied: '+denied.stderr)
evidence={'checks':['actual authenticated mixed history: inbound positive revision and outbound zero baseline; explicit null insertion denied','actual authenticated public acknowledgment affects only inbound','anon and service_role denied both wrapper functions with42501'],'public_api_sha256':hashlib.sha256(source.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'scalar_detail':detail,'scalar_acknowledgment':ack,'limits':['Trusted SQL claims only; not an HTTP/JWT proof','Actual repository decoder can consume retained synthetic scalar_detail']}
(P/'wrapper-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print('Public wrapper mixed-history and role-denial checks passed')
