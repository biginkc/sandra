#!/usr/bin/env python3
"""Actual canonical writes -> durable worker -> typed projection and authenticated facets."""
import argparse,json,subprocess,sys,uuid
from pathlib import Path
from fixture_db import guard,sql,literal
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--owned-fixture',action='store_true');a=ap.parse_args()
if not a.owned_fixture:raise SystemExit('Explicit owned fixture required')
guard();o,u,sid,c,p,m,conv,unknown=[str(uuid.uuid4()) for _ in range(8)]
sql(f"""BEGIN;
INSERT INTO organizations(id,name) VALUES('{o}','Install proof {o}');
INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.test');
INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{sid}','{u}',clock_timestamp()+interval '1 hour');
INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{u}','{o}','owner','active');
INSERT INTO contacts(id,org_id,first_name) VALUES('{c}','{o}','Candidate owner');
INSERT INTO properties(id,org_id,address,state,status,homeowner_contact_id,assigned_user_id) VALUES('{p}','{o}','Owned candidate property','MO','contacted','{c}','{u}');
INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES('{m}','{o}','{conv}','{c}','{p}','sms','inbound','received','Please call regarding this property','+18165550101','+18162804181');
INSERT INTO messages(id,org_id,channel,direction,status,body,from_address) VALUES('{unknown}','{o}','sms','inbound','received','Unknown inquiry','owned-raw-{o}');COMMIT;""")
def drain():return subprocess.check_output([sys.executable,str(P/'worker-step.py'),'--owned-fixture','--rounds','10'],text=True)
first=drain()
row=json.loads(sql(f"SELECT to_jsonb(r) FROM inbox_bridge.filter_rows r WHERE org_id='{o}' AND target_kind='known_conversation' AND target_id='{conv}'"))
if row['assigned_user_id']!=u or not row['has_recent']:raise RuntimeError('Canonical assignment not projected')
sql(f"UPDATE properties SET outreach_dispo='nurture',assigned_user_id=NULL WHERE id='{p}'")
second=drain();row=json.loads(sql(f"SELECT to_jsonb(r) FROM inbox_bridge.filter_rows r WHERE org_id='{o}' AND target_id='{conv}'"))
if row['assigned_user_id'] is not None or row['outreach_dispo']!='nurture':raise RuntimeError('Parent fanout did not update typed metadata')
claims=json.dumps({'sub':u,'session_id':sid,'role':'authenticated','exp':4102444800})
# Enable only inside a rolled-back assertion transaction, never leave fixture/global serving enabled.
prefix="BEGIN;UPDATE inbox_control.rollout SET serving_enabled=true WHERE singleton;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claims="+literal(claims)+';'
result=json.loads(sql(prefix+f"SELECT public.inbox_outcome_counts_v1('{o}','{{\"view\":\"all\",\"hide_noise\":false}}');ROLLBACK;"))
if result['outcome_counts']['nurture']!=1 or result['known_total']!=1 or result['unknown_count']!=1:raise RuntimeError('Canonical outcome facets mismatch')
# Force time-based expiry by moving the canonical message beyond the90-day boundary.
sql(f"UPDATE messages SET created_at=clock_timestamp()-interval '91 days' WHERE id='{m}'")
third=drain()
if sql(f"SELECT count(*) FROM inbox_bridge.summaries WHERE org_id='{o}' AND target_kind='known_conversation' AND target_id='{conv}'")!='0':raise RuntimeError('Canonical age change did not remove expired summary')
if sql('SELECT serving_enabled FROM inbox_control.rollout WHERE singleton')!='f':raise RuntimeError('Smoke left API enabled')

# --- Session isolation mirror against the COMPILED companion (inbox_read.*), T0-T2.
# Proves the compiled candidate carries the same session_id/access_epoch binding as
# the reviewed source -- not just a hash match. Each call below is its own psql
# connection/transaction (fixture_db.sql spawns a fresh one per call, no explicit
# BEGIN, default autocommit), so a boundary created by one call is durable and
# visible to the next. serving_enabled is flipped true only for this block and
# is always restored false in the finally, even on failure.
# T3 (two-connection FOR UPDATE fence) is proven directly against the plpgsql
# source in experiments/inbox-post-render-read/run.py; read-companion.py's own
# installed-body check (above, installed_bodies_verified) already establishes
# this compiled copy is byte-identical to that source, so the blocking behavior
# is not re-proven with a second live two-connection harness here.
isolation_checks=[]
sql("UPDATE inbox_control.rollout SET serving_enabled=true WHERE singleton")
try:
 o2,u2,s1,s2,c2,m2=[str(uuid.uuid4()) for _ in range(6)]
 sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{o2}','Read isolation {o2}');INSERT INTO auth.users(id) VALUES('{u2}');INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{u2}','{o2}','owner','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{s1}','{u2}',clock_timestamp()+interval '1 hour'),('{s2}','{u2}',clock_timestamp()+interval '1 hour');INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body) VALUES('{m2}','{o2}','{c2}','sms','inbound','received','Companion isolation message');COMMIT;")
 def _claims(session):return json.dumps({'sub':u2,'session_id':session,'role':'authenticated','exp':4102444800})
 def call_as(session,q):return sql("SET request.jwt.claims="+literal(_claims(session))+";SET ROLE authenticated;"+q)
 def denied_as(session,q,code,message):
  try:call_as(session,q)
  except RuntimeError as e:
   err=str(e)
   if ('ERROR:  '+code+':') not in err or message not in err:raise RuntimeError('Wrong rejection: '+err)
   return
  raise RuntimeError('Expected rejection did not occur: '+q)
 def unread():return sql(f"SELECT read_at IS NULL FROM messages WHERE id='{m2}'")
 def receipts(bid):return sql(f"SELECT count(*) FROM inbox_read.receipts WHERE boundary_id='{bid}'")
 # Direct inbox_read.* access is deliberately revoked for authenticated by
 # harden-private.sql; the public SECURITY DEFINER wrappers are the entry point.
 # T0: positive control -- same session/epoch succeeds and marks read.
 b0=json.loads(call_as(s1,f"SELECT public.inbox_read_detail('{o2}','{c2}')"))['read_boundary']
 ack0=json.loads(call_as(s1,f"SELECT public.inbox_acknowledge_read('{b0}',0)"))
 if ack0['changed']!=1 or not ack0['completed']:raise RuntimeError('T0 positive control failed to acknowledge (companion)')
 if unread()!='f':raise RuntimeError('T0 positive control did not mark read (companion)')
 isolation_checks.append('T0 positive control acknowledges and marks read (inbox_read.* via public wrapper)')
 sql(f"UPDATE messages SET read_at=NULL WHERE id='{m2}'")
 # T1: session replacement -- S1 creates the boundary; S2 (same user/org/epoch) must not acknowledge it.
 b1=json.loads(call_as(s1,f"SELECT public.inbox_read_detail('{o2}','{c2}')"))['read_boundary']
 denied_as(s2,f"SELECT public.inbox_acknowledge_read('{b1}',0)",'42501','INBOX_READ_NOT_FOUND')
 if unread()!='t':raise RuntimeError('T1 session replacement leaked a read (companion)')
 if receipts(b1)!='0':raise RuntimeError('T1 session replacement leaked a receipt (companion)')
 isolation_checks.append('T1 session replacement rejected without writes (inbox_read.* via public wrapper)')
 # T2: epoch bump -- S1 creates the boundary; a new session for the same user bumps
 # access_epoch; S1's own still-valid session can no longer acknowledge its stale boundary.
 b2=json.loads(call_as(s1,f"SELECT public.inbox_read_detail('{o2}','{c2}')"))['read_boundary']
 sql(f"INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{uuid.uuid4()}','{u2}',clock_timestamp()+interval '1 hour')")
 denied_as(s1,f"SELECT public.inbox_acknowledge_read('{b2}',0)",'42501','INBOX_READ_NOT_FOUND')
 if unread()!='t':raise RuntimeError('T2 epoch bump leaked a read (companion)')
 if receipts(b2)!='0':raise RuntimeError('T2 epoch bump leaked a receipt (companion)')
 isolation_checks.append('T2 access-epoch bump rejected without writes (inbox_read.* via public wrapper)')
finally:
 sql("UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton")
if sql('SELECT serving_enabled FROM inbox_control.rollout WHERE singleton')!='f':raise RuntimeError('Session isolation mirror left API enabled')
if len(isolation_checks)!=3:raise RuntimeError('Session isolation mirror did not complete all checks')

(P/'smoke-evidence.json').write_text(json.dumps({'passed':True,'org':o,'checks':['canonical message capture through durable worker','canonical owner assignment','property outcome/unassignment fanout','authenticated known/unknown outcome facets','canonical timestamp expiry removal','API enablement assertion rolled back']+isolation_checks,'worker_passes':[json.loads(x) for x in [first,second,third]],'scope':'Owned synthetic DB only; does not prove production throughput or human display-name updates. Companion session-isolation mirror covers T0-T2 only; T3 (two-connection fence) is proven against the identical source in inbox-post-render-read/run.py, not re-run here.'},indent=2)+'\n')
print('Canonical candidate worker and facet smoke passed')
