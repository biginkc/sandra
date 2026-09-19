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
if sql("SELECT to_regclass('inbox_t2_read.history_cursors') IS NULL")=='t':sql(source)
functions=re.findall(r'CREATE FUNCTION ([\w.]+)\((.*?)\) RETURNS jsonb.*?AS \$\$(.*?)\$\$;',source,re.S)
need(len(functions)==2,'Expected two SQL functions')
for name,args,body in functions:
 signature=','.join(arg.strip().split()[1] for arg in args.split(','))
 need(sql(f"SELECT prosrc FROM pg_proc WHERE oid='{name}({signature})'::regprocedure")==body.strip(),'Installed source mismatch:'+name)
o,u,owner,s1,s2,c,other,late=[str(uuid.uuid4()) for _ in range(8)]
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o}','Paging {o}');INSERT INTO auth.users(id) VALUES('{owner}'),('{u}');INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{owner}','{o}','owner','active'),('{u}','{o}','member','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{s1}','{u}',clock_timestamp()+interval '1 hour'),('{s2}','{u}',clock_timestamp()+interval '1 hour');INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body,created_at) SELECT gen_random_uuid(),'{o}','{c}','sms','inbound','received','Synthetic history '||i,'2026-09-01 12:00:00.123000+00'::timestamptz+(i/3)*interval '1 microsecond' FROM generate_series(1,153)i;COMMIT;")
def auth(session=s1):return "SET request.jwt.claims='"+json.dumps({'sub':u,'role':'authenticated','session_id':session,'exp':4102444800})+"';SET ROLE authenticated;"
def call(cursor=None,conv=c,org=o):return f"SELECT public.inbox_history_page('{org}','{conv}',"+(f"'{cursor}'" if cursor else 'NULL')+")"
first=json.loads(sql(auth()+call()));pages=[first];cursor=first['next_cursor']
need(len(first['history'])==50 and cursor,'Initial page bound')
need(sql(f"SELECT count(*) FROM messages WHERE org_id='{o}' AND read_at IS NOT NULL")=='0','Fetch marked read')
second=json.loads(sql(auth()+call(cursor)))
repeat=json.loads(sql(auth()+call(cursor)))
need(second==repeat,'Unchanged cursor result should be stable')
while cursor:
 page=json.loads(sql(auth()+call(cursor)));pages.append(page);cursor=page['next_cursor']
need([len(p['history']) for p in pages]==[50,50,50,3],'Wrong page sizes')
ids=[m['id'] for p in pages for m in p['history']]
expected=json.loads(sql(f"SELECT jsonb_agg(id ORDER BY created_at DESC,id DESC) FROM messages WHERE org_id='{o}' AND conversation_id='{c}'"))
need(ids==expected and len(set(ids))==153,'Microsecond/tie order lost, skipped or duplicated')
need(all(p['read_boundary']==first['read_boundary'] and p['head_revision']==first['head_revision'] for p in pages),'Paging changed read boundary')
for query in [auth(s2)+call(first['next_cursor']),auth()+call(first['next_cursor'],conv=other),auth()+call(str(uuid.uuid4()))]:
 denied=sql(query,True);need(denied.returncode!=0 and 'INBOX_READ_NOT_FOUND' in denied.stderr,'Cursor binding bypass')
for role in ['anon','service_role']:
 denied=sql(f'SET ROLE {role};'+call(),True);need(denied.returncode!=0 and '42501' in denied.stderr,'Wrapper privilege bypass')
# A late backdated arrival belongs in live older history but not the captured read.
sql(f"INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body,created_at) VALUES('{late}','{o}','{c}','sms','inbound','received','Late synthetic','2026-09-01 12:00:00.123020+00')")
after=json.loads(sql(auth()+call(first['next_cursor'])))
need(late in [m['id'] for m in after['history']],'Late older arrival absent')
need(after['head_revision']==first['head_revision'],'Late arrival expanded captured boundary')
ack=json.loads(sql(auth()+f"SELECT public.inbox_acknowledge_read('{first['read_boundary']}',0)"))
need(ack['changed']==153 and ack['completed'],'Original captured read set wrong')
need(sql(f"SELECT read_at IS NULL FROM messages WHERE id='{late}'")=='t','Late inbound incorrectly acknowledged')
sql(f"UPDATE inbox_t2_read.boundaries SET expires_at=clock_timestamp()-interval '1 second' WHERE id='{first['read_boundary']}'")
denied=sql(auth()+call(first['next_cursor']),True);need(denied.returncode!=0 and 'INBOX_READ_EXPIRED' in denied.stderr,'Expired cursor served')

# Mutation control for history_page()'s boundary.session_id/access_epoch clause: the
# cursor-level session/epoch check above (line 44) can never itself be bypassed via the
# public API (a cursor is only ever created under its own boundary's session/epoch), so
# it alone never exercises the SEPARATE boundary-level clause. Fabricate the decoupled
# state directly (a cursor whose own session/epoch matches the caller but whose
# boundary_id points at a DIFFERENT session's boundary) to prove that second clause is
# independently load-bearing, not merely redundant with the first.
fresh=json.loads(sql(auth(s1)+f"SELECT inbox_t2_read.detail('{o}','{c}')"))
fab_boundary=fresh['read_boundary'];fab_cursor=str(uuid.uuid4())
sql(f"INSERT INTO inbox_t2_read.history_cursors(id,boundary_id,session_id,access_epoch,before_at,before_id) VALUES('{fab_cursor}','{fab_boundary}','{s2}',(SELECT access_epoch FROM inbox_t2_read.boundaries WHERE id='{fab_boundary}'),now(),gen_random_uuid())")
denied=sql(auth(s2)+call(fab_cursor),True);need(denied.returncode!=0 and 'INBOX_READ_NOT_FOUND' in denied.stderr,'Fabricated cross-session cursor should be rejected by boundary.session_id clause')
correct_body=re.search(r"CREATE FUNCTION inbox_t2_read\.history_page\(.*?AS \$\$(.*?)\$\$;",source,re.S).group(1)
target="OR boundary.session_id IS DISTINCT FROM (a->>'session_id')::uuid OR boundary.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN"
replacement="THEN"
need(target in correct_body,'Expected boundary session_id/access_epoch clause not found in source')
mutated_body=correct_body.replace(target,replacement,1);need(mutated_body!=correct_body,'Mutation did not change history_page body')
sql("CREATE OR REPLACE FUNCTION inbox_t2_read.history_page(o uuid,c uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$"+mutated_body+"$$;")
mres=sql(auth(s2)+call(fab_cursor),True)
need(mres.returncode==0,'MUTATION CONTROL FAILED: removing the boundary session_id/access_epoch clause did not let the fabricated cross-session cursor wrongly succeed')
sql("CREATE OR REPLACE FUNCTION inbox_t2_read.history_page(o uuid,c uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$"+correct_body+"$$;")
need(sql("SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_read.history_page(uuid,uuid,uuid)'::regprocedure")==correct_body.strip(),'Restored history_page body does not match source')
denied=sql(auth(s2)+call(fab_cursor),True);need(denied.returncode!=0 and 'INBOX_READ_NOT_FOUND' in denied.stderr,'Post-restore fabricated cross-session cursor should be rejected again')

checks=['four exact pages 50/50/50/3 with microsecond/tied timestamp order','unchanged cursor repeat is stable; all pages preserve original read boundary','same-user other-session, wrong-conversation and unknown cursor denied','anon/service_role direct execution denied','late backdated arrival visible in older history but excluded from original acknowledgment','expired history cursor denied','mutation control: fabricated cursor with matching session but a different session\'s boundary is rejected by the boundary.session_id/access_epoch clause; removing that clause lets it wrongly succeed, restoring it rejects again']
(P/'evidence.json').write_text(json.dumps({'checks':checks,'source_sha256':hashlib.sha256(source.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'first_page':first,'second_page':second,'limitations':['SQL claims, not JWT transport','Live keyset traversal, not an immutable history snapshot','50-row exact terminal page can require one empty final request','Cursor retention/admission still requires release design']},indent=2)+'\n')
print('Passed '+str(len(checks))+' actual history paging groups')
