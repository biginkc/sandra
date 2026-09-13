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
(P/'smoke-evidence.json').write_text(json.dumps({'passed':True,'org':o,'checks':['canonical message capture through durable worker','canonical owner assignment','property outcome/unassignment fanout','authenticated known/unknown outcome facets','canonical timestamp expiry removal','API enablement assertion rolled back'],'worker_passes':[json.loads(x) for x in [first,second,third]],'scope':'Owned synthetic DB only; does not prove production throughput or human display-name updates'},indent=2)+'\n')
print('Canonical candidate worker and facet smoke passed')
