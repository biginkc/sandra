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
if sql("SELECT to_regnamespace('inbox_t2_read') IS NULL")=='t':
 sql((P/'setup.sql').read_text())
else:
 import re
 for name,args,body in re.findall(r'CREATE FUNCTION inbox_t2_read\.(\w+)\((.*?)\) RETURNS jsonb.*?AS \$\$(.*?)\$\$;', (P/'setup.sql').read_text(), re.S):
  signature=','.join(arg.strip().split()[-1] for arg in args.split(','))
  actual=sql(f"SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_read.{name}({signature})'::regprocedure")
  need(actual==body.strip(),'Installed source differs: '+name)
u,o,s,c,owner,other=[str(uuid.uuid4()) for _ in range(6)]
claims=json.dumps({'sub':u,'role':'authenticated','session_id':s,'exp':4102444800})
prefix="SET request.jwt.claims='"+claims+"';SET ROLE authenticated;"
def call(q):return sql(prefix+q)
def denied(q,code,message):
 r=sql(prefix+q,True)
 need(r.returncode!=0 and ('ERROR:  '+code+':') in r.stderr and message in r.stderr,'Wrong rejection: '+r.stderr)
checks=[]
def mark(name):checks.append(name)
sql(f"INSERT INTO organizations(id,name) VALUES('{o}','Read fixture {o}');INSERT INTO auth.users(id) VALUES('{u}'),('{owner}');INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{owner}','{o}','owner','active'),('{u}','{o}','member','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{s}','{u}',clock_timestamp()+interval '1 hour');INSERT INTO messages(org_id,conversation_id,channel,direction,body) SELECT '{o}','{c}','sms','inbound','Owned read '||i FROM generate_series(1,451) i;")
def detail():return json.loads(call(f"SELECT inbox_t2_read.detail('{o}','{c}')"))
def ack(b,n):return json.loads(call(f"SELECT inbox_t2_read.acknowledge('{b}',{n})"))
d=detail();b=d['read_boundary']
need(len(d['history'])==50 and d['head_revision']=='451','Snapshot page/head')
need(sql(f"SELECT count(*) FROM messages WHERE org_id='{o}' AND read_at IS NOT NULL")=='0','Detail mutated reads')
mark('bounded latest50 snapshot records boundary without acknowledging history')
sql(f"INSERT INTO messages(org_id,conversation_id,channel,direction,body,created_at) VALUES('{o}','{c}','sms','inbound','Late backdated',clock_timestamp()-interval '1 year')")
denied(f"SELECT inbox_t2_read.acknowledge('{b}',1)",'55000','INBOX_READ_BATCH_CONFLICT')
receipts=[ack(b,n) for n in range(3)]
need([r['changed'] for r in receipts]==[200,200,51] and [r['completed'] for r in receipts]==[False,False,True],'Bounded receipts')
need(sql(f"SELECT count(*) FROM messages WHERE org_id='{o}' AND read_at IS NOT NULL")=='451','Historical coverage')
need(sql(f"SELECT count(*) FROM messages WHERE org_id='{o}' AND body='Late backdated' AND read_at IS NULL")=='1','Late arrival acknowledged')
mark('three bounded batches acknowledge451 including older pages; backdated later arrival remains unread')
sql(f"UPDATE messages SET read_at=NULL WHERE id=(SELECT id FROM messages WHERE org_id='{o}' AND read_at IS NOT NULL ORDER BY id LIMIT 1)")
need(ack(b,2)==receipts[2],'Replay receipt differs')
need(sql(f"SELECT count(*) FROM messages WHERE org_id='{o}' AND read_at IS NULL")=='2','Completed replay reran mutation')
mark('lost-response replay returns immutable completed receipt without re-marking later unread')
denied(f"SELECT inbox_t2_read.acknowledge('{other}',0)",'42501','INBOX_READ_NOT_FOUND')
denied('SELECT * FROM inbox_t2_read.boundaries','42501','permission denied')
mark('unknown boundary and direct private storage access denied')
expired=detail()['read_boundary']
sql(f"UPDATE inbox_t2_read.boundaries SET expires_at=clock_timestamp()-interval '1 second' WHERE id='{expired}'")
denied(f"SELECT inbox_t2_read.acknowledge('{expired}',0)",'55000','INBOX_READ_EXPIRED')
need(sql(f"SELECT count(*) FROM inbox_t2_read.receipts WHERE boundary_id='{expired}'")=='0','Expired receipt persisted')
mark('expired unaccepted boundary fails without writes')
fresh=detail()['read_boundary']
sql(f"UPDATE memberships SET access_status='suspended' WHERE user_id='{u}'")
denied(f"SELECT inbox_t2_read.acknowledge('{fresh}',0)",'42501','INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING')
sql(f"UPDATE memberships SET access_status='active' WHERE user_id='{u}';DELETE FROM auth.sessions WHERE id='{s}'")
denied(f"SELECT inbox_t2_read.acknowledge('{fresh}',0)",'42501','INBOX_SESSION_REVOKED')
mark('current membership suspension and session deletion deny acknowledgment')
(P/'evidence.json').write_text(json.dumps({'checks':checks,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256((P/'run.py').read_bytes()).hexdigest(),'limits':['SQL trusted claims only, no JWT transport','No browser render binding yet','Concurrency, DNC and source identity cases pending','No production migration or activation']},indent=2)+'\n')
print(f'{len(checks)} read acknowledgment groups passed')
