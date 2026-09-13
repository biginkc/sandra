#!/usr/bin/env python3
"""Explicitly owned canonical SQL rehearsal, never a JWT verification claim."""
import json,subprocess,sys,uuid,hashlib
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q,ok=True):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input="SET statement_timeout='20s'; SET lock_timeout='2s';"+q,text=True,capture_output=True,timeout=30)
 if ok and r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip() if ok else r

def need(v,label):
 if not v:raise RuntimeError(label)
validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','marker')

u,o,o2,sid,owner=[str(uuid.uuid4()) for _ in range(5)]
claims=json.dumps({'sub':u,'role':'authenticated','session_id':sid,'exp':4102444800})
prefix="SET request.jwt.claims='"+claims+"';"
sql(f"INSERT INTO organizations(id,name) VALUES('{o}','Bridge owned {o}'),('{o2}','Bridge foreign {o2}'); INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.test'); INSERT INTO auth.users(id) VALUES('{owner}'); INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{owner}','{o}','owner','active'),('{owner}','{o2}','owner','active'),('{u}','{o}','member','active'); INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{sid}','{u}',clock_timestamp()+interval '1 hour');")
checks=[]
def mark(name):checks.append(name)
def call(q):return sql(prefix+q)
def denied(q,label):need(sql(prefix+q,False).returncode!=0,label);mark(label)
a=json.loads(call(f"SELECT inbox_t2_bridge.authorize('{o}')"));need(a['user_id']==u and a['active_membership_count']==1,'canonical auth');mark('canonical session and single membership')
denied(f"SELECT inbox_t2_bridge.authorize('{o2}')",'cross tenant denied')
denied(f"SELECT inbox_t2_bridge.create_scope('{o}', '{{}}',500)",'invalid filter denied')
denied(f"SELECT inbox_t2_bridge.create_scope('{o}', '{{\"view\":\"active\"}}',501)",'oversize denied')
# Narrow summary fixture rows only, including opposite kinds with the same UUID.
t=str(uuid.uuid4())
sql(f"INSERT INTO inbox_t2_bridge.summaries VALUES('{o}','known_conversation','{t}',1,1,'Known','','','','','',true,clock_timestamp(),true,false,false,true),('{o}','unknown_sender','{t}',1,1,'Unknown','','','','','',null,clock_timestamp(),true,false,false,false),('{o2}','known_conversation','{t}',1,1,'Foreign','','','','','',true,clock_timestamp(),true,false,false,true);")
w=json.loads(call(f"SELECT inbox_t2_bridge.create_scope('{o}','{{\"view\":\"active\"}}',500)"));need(len(w['targets'])==2 and len({x['kind'] for x in w['targets']})==2,'typed membership');mark('typed same UUID membership without foreign tenant')
need(call(f"SELECT inbox_t2_bridge.bind_handle('{w['id']}',0,NULL,'handle-one')")=='t','bind')
need(call(f"SELECT inbox_t2_bridge.bind_handle('{w['id']}',0,NULL,'other')")=='f','CAS');mark('handle CAS')
denied(f"SELECT inbox_t2_bridge.create_scope('{o}','{{\"view\":\"active\"}}',500)",'creation throttle')
sql(f"UPDATE inbox_t2_bridge.worksets SET created_at=created_at-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id='{w['id']}'")
w2=json.loads(call(f"SELECT inbox_t2_bridge.create_scope('{o}','{{\"view\":\"active\"}}',500,'{w['id']}')"));need(call(f"SELECT inbox_t2_bridge.get_scope('{w['id']}')")=='','replaced scope remains usable');mark('atomic explicit replacement accepts expired same-context predecessor and revokes it')
sql(f"UPDATE memberships SET access_status='suspended' WHERE user_id='{u}'")
denied(f"SELECT inbox_t2_bridge.get_scope('{w2['id']}')",'suspension denied')
sql(f"UPDATE memberships SET access_status='active' WHERE user_id='{u}'")
need(call(f"SELECT inbox_t2_bridge.get_scope('{w2['id']}')")=='','old epoch revived');mark('restored access does not revive old scope')
sql(f"INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{u}','{o2}','member','active')")
denied(f"SELECT inbox_t2_bridge.authorize('{o}')",'global membership ambiguity denied')
sql(f"DELETE FROM memberships WHERE user_id='{u}' AND org_id='{o2}';UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id='{sid}'")
denied(f"SELECT inbox_t2_bridge.authorize('{o}')",'session expiry denied')
# Public RPC privilege boundary: actual database roles, not a boolean allow map.
sql(f"UPDATE auth.sessions SET not_after=clock_timestamp()+interval '1 hour' WHERE id='{sid}'")
need(sql(prefix+f"SET ROLE authenticated; SELECT public.inbox_authorize_sync('{o}')")!='','authenticated RPC failed')
need(sql(prefix+f"SET ROLE anon; SELECT public.inbox_authorize_sync('{o}')",False).returncode!=0,'anon RPC allowed')
need(sql(prefix+"SET ROLE authenticated; SELECT * FROM inbox_t2_bridge.worksets",False).returncode!=0,'private table readable')
mark('authenticated RPC allowed; anonymous RPC and direct private reads denied')
c=str(uuid.uuid4());summary=json.dumps({'exists':True,'contact_name':'Canonical projection','last_message_preview':'hello','visible_all_hide_noise':True,'unread_count':1})
sql(f"INSERT INTO inbox_t2_maintained.rows VALUES('{o}','known_conversation','{c}',1,1,'{summary}',null)")
need(sql(f"SELECT name||':'||unread::text FROM inbox_t2_bridge.summaries WHERE org_id='{o}' AND target_id='{c}'")=='Canonical projection:true','maintained trigger projection')
sql(f"UPDATE inbox_t2_maintained.rows SET summary='{{\"exists\":false}}',revision=2 WHERE org_id='{o}' AND target_id='{c}'")
need(sql(f"SELECT count(*) FROM inbox_t2_bridge.summaries WHERE org_id='{o}' AND target_id='{c}'")=='0','projection tombstone')
mark('actual maintained publication trigger and tombstone remove narrow row')
(P/'behavior-evidence.json').write_text(json.dumps({'passed':True,'checks':checks,'limitations':['SQL claims are preverified test input, not JWT signature verification','No actual Electric replication in this test','No cursor/search implementation yet']},indent=2)+'\n')
print(f'{len(checks)} canonical bridge checks passed')
