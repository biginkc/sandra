#!/usr/bin/env python3
"""Actual canonical cursor behavior in the explicitly owned synthetic fixture."""
import hashlib,json,re,subprocess,sys,uuid
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
def sql(q,error=False):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],input="SET statement_timeout='15s';SET lock_timeout='2s';"+q,text=True,capture_output=True,timeout=25)
 if not error:need(r.returncode==0,r.stderr)
 return r if error else r.stdout.strip()
validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture')
source=(P/'setup.sql').read_text()
if sql("SELECT to_regclass('inbox_t2_read.unknown_history_cursors') IS NULL")=='t':sql(source)
functions=re.findall(r'CREATE FUNCTION ([\w.]+)\((.*?)\) RETURNS jsonb.*?AS \$\$(.*?)\$\$;',source,re.S)
need(len(functions)==3,'Expected three SQL functions')
for name,args,body in functions:
 signature=','.join(arg.strip().split()[1] for arg in args.split(','))
 need(sql(f"SELECT prosrc FROM pg_proc WHERE oid='{name}({signature})'::regprocedure")==body.strip(),'Installed source mismatch:'+name)
o,foreign,u,owner,s1,s2,contact,c=[str(uuid.uuid4()) for _ in range(8)]
raw='owned-raw-'+str(uuid.uuid4())
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Unknown history'),('{foreign}','Foreign history');INSERT INTO auth.users(id) VALUES('{owner}'),('{u}');INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{owner}','{o}','owner','active'),('{u}','{o}','member','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{s1}','{u}',clock_timestamp()+interval '1 hour'),('{s2}','{u}',clock_timestamp()+interval '1 hour');INSERT INTO contacts(id,org_id,first_name) VALUES('{contact}','{o}','Owned contact');INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body,from_address,created_at,dismissed_at,contact_id) SELECT gen_random_uuid(),'{o}','{c}','sms',CASE WHEN i%3=0 THEN 'outbound' ELSE 'inbound' END,'received','History '||i,'{raw}','2026-09-01 12:00:00.123000+00'::timestamptz+(i/3)*interval '1 microsecond',CASE WHEN i%4=0 THEN clock_timestamp() END,CASE WHEN i%5=0 THEN '{contact}'::uuid END FROM generate_series(1,100)i;INSERT INTO messages(org_id,channel,direction,status,body,from_address) VALUES('{foreign}','sms','inbound','received','Foreign hidden','{raw}'),('{o}','sms','inbound','received','Raw mismatch hidden','{raw} '),('{o}','email','inbound','received','Email hidden','{raw}');COMMIT;")
group=sql(f"SELECT sender_group_id FROM inbox_t2_message_capture.sender_groups WHERE org_id='{o}' AND raw_sender='{raw}'")
other_group=sql(f"SELECT sender_group_id FROM inbox_t2_message_capture.sender_groups WHERE org_id='{o}' AND raw_sender='{raw} '")
def auth(session=s1):return "SET request.jwt.claims='"+json.dumps({'sub':u,'role':'authenticated','session_id':session,'exp':4102444800})+"';SET ROLE authenticated;"
def call(cursor=None,g=group):return f"SELECT public.inbox_unknown_history_page('{o}','{g}',"+(f"'{cursor}'" if cursor else 'NULL')+")"
first=json.loads(sql(auth()+call()));second=json.loads(sql(auth()+call(first['next_cursor'])));last=json.loads(sql(auth()+call(second['next_cursor'])))
need([len(x['history']) for x in [first,second,last]]==[50,50,0] and last['next_cursor'] is None,'Exact terminal page bound')
actual=[m['id'] for p in [first,second] for m in p['history']]
expected=json.loads(sql(f"SELECT jsonb_agg(id ORDER BY created_at DESC,id DESC) FROM messages WHERE org_id='{o}' AND channel='sms' AND from_address COLLATE \"C\"='{raw}'"))
need(actual==expected and len(set(actual))==100,'Raw equality/order lost or foreign rows leaked')
need(any(m['dismissed_at_raw'] for p in [first,second] for m in p['history']),'Dismissed history hidden')
need(any(m['direction']=='outbound' for p in [first,second] for m in p['history']),'Legacy from-address outbound missing')
need(sql(f"SELECT count(*) FROM messages WHERE org_id='{o}' AND read_at IS NOT NULL")=='0','History acknowledged messages')
for query in [auth(s2)+call(first['next_cursor']),auth()+call(first['next_cursor'],other_group),auth()+call(str(uuid.uuid4()))]:
 denied=sql(query,True);need(denied.returncode!=0 and 'INBOX_READ_NOT_FOUND' in denied.stderr,'Cursor binding bypass')
for role in ['anon','service_role']:
 denied=sql(f'SET ROLE {role};'+call(),True);need(denied.returncode!=0 and '42501' in denied.stderr,'Wrapper privilege bypass')
sql(f"UPDATE inbox_t2_read.unknown_history_cursors SET expires_at=clock_timestamp()-interval '1 second' WHERE id='{first['next_cursor']}'")
denied=sql(auth()+call(first['next_cursor']),True);need(denied.returncode!=0 and 'INBOX_READ_EXPIRED' in denied.stderr,'Expired cursor served')
sql(f"DELETE FROM auth.sessions WHERE id='{s1}'")
denied=sql(auth()+call(),True);need(denied.returncode!=0 and '42501' in denied.stderr,'Revoked session served')
checks=['exact50/50/0 pages preserve raw microsecond and UUID order','same raw sender cross-org, different raw string and email excluded','matched/dismissed and legacy from-address outbound preserved without read acknowledgment','other-session/wrong-group/unknown cursor denied','anon and service_role denied','expired cursor and revoked session denied']
(P/'evidence.json').write_text(json.dumps({'checks':checks,'source_sha256':hashlib.sha256(source.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'page_sizes':[50,50,0],'limits':['Owned canonical SQL claims; not browser JWT transport','Legacy raw from_address history; no new to_address stitching','Live keyset pages; cursor retention/admission release dependency']},indent=2)+'\n')
print('Six actual unknown history groups passed')
