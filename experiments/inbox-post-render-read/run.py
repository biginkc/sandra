#!/usr/bin/env python3
"""Owned canonical SQL behavior tests; claims are not a JWT transport proof."""
import hashlib,json,re,subprocess,sys,time,uuid
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

# --- Session isolation (T0-T3): a read boundary is bound to the session_id and
# access_epoch that created it. A different session for the SAME user/org, or the
# SAME session after its access_epoch has moved on, must never be able to reuse
# (and thereby silently mark read) another session's stale boundary.
o2,u2,owner2,s1,s2,c2=[str(uuid.uuid4()) for _ in range(6)]
sql(f"INSERT INTO organizations(id,name) VALUES('{o2}','Session isolation {o2}');INSERT INTO auth.users(id) VALUES('{u2}'),('{owner2}');INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{owner2}','{o2}','owner','active'),('{u2}','{o2}','member','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{s1}','{u2}',clock_timestamp()+interval '1 hour'),('{s2}','{u2}',clock_timestamp()+interval '1 hour');INSERT INTO messages(org_id,conversation_id,channel,direction,body) VALUES('{o2}','{c2}','sms','inbound','Session isolation message');")
def prefix_for(session):return "SET request.jwt.claims='"+json.dumps({'sub':u2,'role':'authenticated','session_id':session,'exp':4102444800})+"';SET ROLE authenticated;"
def call_as(session,q):return sql(prefix_for(session)+q)
def denied_as(session,q,code,message):
 r=sql(prefix_for(session)+q,True)
 need(r.returncode!=0 and ('ERROR:  '+code+':') in r.stderr and message in r.stderr,'Wrong rejection: '+r.stderr)
def unread_count():return sql(f"SELECT count(*) FROM messages WHERE org_id='{o2}' AND conversation_id='{c2}' AND read_at IS NULL")
def receipt_count(bid):return sql(f"SELECT count(*) FROM inbox_t2_read.receipts WHERE boundary_id='{bid}'")

# T0: positive control -- same session/epoch succeeds and marks read.
detail0=json.loads(call_as(s1,f"SELECT inbox_t2_read.detail('{o2}','{c2}')"));b0=detail0['read_boundary']
ack0=json.loads(call_as(s1,f"SELECT inbox_t2_read.acknowledge('{b0}',0)"))
need(ack0['changed']==1 and ack0['completed'],'T0 positive control failed to acknowledge')
need(unread_count()=='0','T0 positive control did not mark read')
mark('T0 positive control: same session/epoch acknowledges and marks read')
sql(f"UPDATE messages SET read_at=NULL WHERE org_id='{o2}' AND conversation_id='{c2}'")

# T1: session replacement -- S1 creates the boundary; S2 (same user/org/epoch,
# no epoch-bumping event occurred between S1 and S2 both already existing) must
# not be able to acknowledge S1's boundary.
before1=unread_count()
detail1=json.loads(call_as(s1,f"SELECT inbox_t2_read.detail('{o2}','{c2}')"));b1=detail1['read_boundary']
denied_as(s2,f"SELECT inbox_t2_read.acknowledge('{b1}',0)",'42501','INBOX_READ_NOT_FOUND')
need(unread_count()==before1,'T1 session replacement leaked a read')
need(receipt_count(b1)=='0','T1 session replacement leaked a receipt')
mark('T1 session replacement: different session_id, same epoch, is rejected without writes')

# T2: epoch bump -- S1 creates the boundary; a new session for the same user
# bumps access_epoch; S1's own (still valid, unexpired) session can no longer
# acknowledge its now-stale boundary.
before2=unread_count()
detail2=json.loads(call_as(s1,f"SELECT inbox_t2_read.detail('{o2}','{c2}')"));b2=detail2['read_boundary']
sql(f"INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{uuid.uuid4()}','{u2}',clock_timestamp()+interval '1 hour')")
denied_as(s1,f"SELECT inbox_t2_read.acknowledge('{b2}',0)",'42501','INBOX_READ_NOT_FOUND')
need(unread_count()==before2,'T2 epoch bump leaked a read')
need(receipt_count(b2)=='0','T2 epoch bump leaked a receipt')
mark('T2 access-epoch bump: same session_id but stale epoch is rejected without writes')

# T3: two-connection fence -- a concurrent holder transaction takes the
# access_epochs FOR UPDATE row lock that acknowledge() itself takes; the
# waiting acknowledge() must actually block on it (not race around it), and
# once the holder bumps the epoch and commits, the resumed acknowledge() must
# observe the NEW epoch and reject, never the stale one it started under.
def _psql_session(prefix=''):
 name='run-fence-'+uuid.uuid4().hex
 p=subprocess.Popen(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','VERBOSITY=verbose'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 p.stdin.write(f"SET application_name='{name}';"+prefix+'\n');p.stdin.flush()
 return p,name
def _barrier(p,q):
 tag='ready'+uuid.uuid4().hex
 p.stdin.write(q+'\n\\echo '+tag+'\n');p.stdin.flush()
 deadline=time.monotonic()+10
 while time.monotonic()<deadline:
  line=p.stdout.readline()
  if not line:raise RuntimeError('Session closed before barrier')
  if line.strip()==tag:return
 raise RuntimeError('Session barrier timed out')
def _blocked(waiter_name,holder_name):
 deadline=time.monotonic()+8
 while time.monotonic()<deadline:
  if sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity h ON h.application_name='{holder_name}' WHERE w.application_name='{waiter_name}' AND h.pid=ANY(pg_blocking_pids(w.pid)))")=='t':return
  time.sleep(.05)
 raise RuntimeError('Expected actual lock wait absent')
before3=unread_count()
detail3=json.loads(call_as(s1,f"SELECT inbox_t2_read.detail('{o2}','{c2}')"));b3=detail3['read_boundary']
holder,holder_name=_psql_session()
_barrier(holder,f"BEGIN;SELECT 1 FROM inbox_t2_bridge.access_epochs WHERE user_id='{u2}' FOR UPDATE;")
worker,worker_name=_psql_session(prefix_for(s1))
worker.stdin.write(f"SELECT inbox_t2_read.acknowledge('{b3}',0);\n");worker.stdin.flush()
_blocked(worker_name,holder_name)
holder.stdin.write(f"INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{uuid.uuid4()}','{u2}',clock_timestamp()+interval '1 hour');COMMIT;\n\\q\n");holder.stdin.flush()
need(holder.wait(timeout=10)==0,'T3 holder failed')
worker.stdin.write('\\q\n');worker.stdin.close()
_,werr=worker.communicate(timeout=15)
need('ERROR:  42501:' in werr and 'INBOX_READ_NOT_FOUND' in werr,'T3 fence did not reject: '+werr)
need(unread_count()==before3,'T3 fence leaked a read')
need(receipt_count(b3)=='0','T3 fence leaked a receipt')
mark('T3 two-connection fence: acknowledge() actually blocks on the FOR UPDATE epoch lock; once the holder bumps the epoch and commits, the resumed call observes the new epoch and rejects without writes')

# Mutation-first: prove the session_id equality clause in acknowledge() is
# load-bearing. Remove ONLY that clause from the installed function (access_epoch
# stays), re-run the T1 scenario and confirm it now WRONGLY succeeds, then restore
# the exact source body and confirm T1 is rejected again.
correct_ack_body=re.search(r"CREATE FUNCTION inbox_t2_read\.acknowledge\(.*?AS \$\$(.*?)\$\$;",(P/'setup.sql').read_text(),re.S).group(1)
target="OR w.session_id IS DISTINCT FROM (a->>'session_id')::uuid OR w.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN"
replacement="OR w.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN"
need(target in correct_ack_body,'Expected session_id/access_epoch clause not found in source body')
mutated_body=correct_ack_body.replace(target,replacement,1)
need(mutated_body!=correct_ack_body,'Mutation did not change acknowledge body')
sql("CREATE OR REPLACE FUNCTION inbox_t2_read.acknowledge(b uuid,batch_number integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$"+mutated_body+"$$;")
detailm=json.loads(call_as(s1,f"SELECT inbox_t2_read.detail('{o2}','{c2}')"));bm=detailm['read_boundary']
mres=json.loads(call_as(s2,f"SELECT inbox_t2_read.acknowledge('{bm}',0)"))
need(mres['changed']==1,'MUTATION CONTROL FAILED: removing the session_id clause did not let a replaced session wrongly acknowledge -- T1 guard is not actually load-bearing')
mark("mutation control: removing the session_id equality clause lets a replaced session (S2) wrongly acknowledge S1's boundary -- T1 fails as expected, proving the check is load-bearing")
sql("CREATE OR REPLACE FUNCTION inbox_t2_read.acknowledge(b uuid,batch_number integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$"+correct_ack_body+"$$;")
need(sql("SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_read.acknowledge(uuid,integer)'::regprocedure")==correct_ack_body.strip(),'Restored acknowledge body does not match source')
detailr=json.loads(call_as(s1,f"SELECT inbox_t2_read.detail('{o2}','{c2}')"));br=detailr['read_boundary']
before_r=unread_count()
denied_as(s2,f"SELECT inbox_t2_read.acknowledge('{br}',0)",'42501','INBOX_READ_NOT_FOUND')
need(unread_count()==before_r,'Post-restore T1 leaked a read')
mark('post-restore re-check: T1 rejects again after restoring the exact source session_id equality clause')

(P/'evidence.json').write_text(json.dumps({'checks':checks,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256((P/'run.py').read_bytes()).hexdigest(),'limits':['SQL trusted claims only, no JWT transport','No browser render binding yet','DNC case pending here (covered in concurrency.py)','No production migration or activation']},indent=2)+'\n')
print(f'{len(checks)} read acknowledgment groups passed')
