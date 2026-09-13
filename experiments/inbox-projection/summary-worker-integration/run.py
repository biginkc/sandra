#!/usr/bin/env python3
if not __debug__:raise SystemExit('Refusing optimized Python before fixture access')
import argparse,hashlib,json,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
args=argparse.ArgumentParser();args.add_argument('--run-owned-fixture',action='store_true');opt=args.parse_args()
if not opt.run_owned_fixture:raise SystemExit('Explicit fixture grant required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
PSQL=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def need(ok,msg):
 if ok is not True:raise RuntimeError(msg)
def sql(s,check=True):
 r=subprocess.run(PSQL,input="SET statement_timeout='20s';SET lock_timeout='2s';"+s,text=True,capture_output=True,timeout=30)
 if check and r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip() if check else r
def lit(v):return 'NULL' if v is None else "'"+str(v).replace("'","''")+"'"
def uid():return str(uuid.uuid4())
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0]);validate_cron(sql('SHOW cron.launch_active_jobs;'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity;')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture marker')
need(sql("SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname='zzzz_inbox_t2_projection_dirty';")=='O','Dirty capture not enabled')
need(sql("SELECT to_regnamespace('inbox_t2_summary_worker') IS NULL;")=='t','Already installed; refusing before writes')
functions=['inbox_t2_summary_contract.compute(uuid,uuid,timestamptz)','inbox_t2_projection_proof.snapshot(uuid,uuid)','inbox_t2_projection_proof.commit_candidate(jsonb)','inbox_t2_projection_proof.capture_dirty()']
def hashes():return {f:sql(f'SELECT md5(pg_get_functiondef({lit(f)}::regprocedure));') for f in functions}
original=hashes();sql((P/'setup.sql').read_text())
org,conv,cid,pid,mid=[uid() for _ in range(5)];asof=sql('SELECT statement_timestamp()::text;')
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{org}','Summary worker {org}');INSERT INTO contacts(id,org_id,first_name,last_name) VALUES('{cid}','{org}','Worker','Initial');INSERT INTO properties(id,org_id,address,state,status,homeowner_contact_id) VALUES('{pid}','{org}','Synthetic worker {pid}','MO','contacted','{cid}');INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,created_at) VALUES('{mid}','{org}','{conv}','{cid}','{pid}','sms','inbound','received','initial',{lit(asof)}::timestamptz-interval '1 hour');COMMIT;")
checks=[];observations={}
def passed(name):checks.append({'name':name,'passed':True})
def snapshot(at=asof):return json.loads(sql(f"SELECT inbox_t2_summary_worker.snapshot('{org}','{conv}',{lit(at)}::timestamptz);"))
def compute(at=asof):return json.loads(sql(f"SELECT inbox_t2_summary_contract.compute('{org}','{conv}',{lit(at)}::timestamptz);"))
def commit(c):return sql(f'SELECT inbox_t2_summary_worker.commit_candidate({lit(json.dumps(c))}::jsonb);')
def state():return json.loads(sql(f"SELECT jsonb_build_object('generation',d.generation::text,'ack',d.acknowledged_generation::text,'revision',p.revision::text,'source_generation',p.source_generation::text,'full_revision',s.revision::text,'full_generation',s.source_generation::text,'summary',s.summary) FROM inbox_t2_projection_proof.dirty d LEFT JOIN inbox_t2_projection_proof.projections p USING(org_id,conversation_id) LEFT JOIN inbox_t2_summary_worker.summaries s USING(org_id,conversation_id) WHERE d.org_id='{org}' AND d.conversation_id='{conv}';"))
a=snapshot();need(a['generation']=='1' and a['expected_revision']=='0' and a['summary']==compute(),'Snapshot real compute/G/R mismatch');need(commit(a)=='applied','Initial publication failed');s=state();need(s['summary']==a['summary'] and s['full_revision']==s['revision']=='1' and s['ack']=='1','Full JSON publication mismatch');passed('one compute snapshot captures actual summary/G/R; full JSON and CAS metadata publish atomically')
# Old compute does not acknowledge writes that occurred afterward.
sql(f"UPDATE messages SET body='version two' WHERE id='{mid}';");older=snapshot()
sql(f"UPDATE messages SET body='version three' WHERE id='{mid}';");need(commit(older)=='applied','Approved older generation publication rejected');s=state();need(int(s['generation'])>int(s['ack']) and s['summary']['last_message_preview']=='version two','Newer dirty work was lost');passed('older captured generation can publish while a newer message generation remains pending')
newer=snapshot();peer=json.loads(json.dumps(newer));need(commit(newer)=='applied','Pending newer generation not applied');published=state();need(published['summary']==compute() and published['generation']==published['ack'],'Current summary did not catch up');need(commit(peer)=='projection_conflict' and state()==published,'Same-revision peer clobbered publication');need(commit(older)=='invalid_generation' and state()==published,'Older acknowledged generation clobbered newer result');passed('new publication rejects stale revision peer and older generation without changing stored JSON')
# Force persistence failure after installed CAS runs, proving a shared transaction.
sql(f"UPDATE messages SET body='persist after rollback' WHERE id='{mid}';");candidate=snapshot();before=state()
r=sql(f"BEGIN;ALTER TABLE inbox_t2_summary_worker.summaries ADD CONSTRAINT fixture_reject_full_json CHECK(false) NOT VALID;SELECT inbox_t2_summary_worker.commit_candidate({lit(json.dumps(candidate))}::jsonb);COMMIT;",False)
need(r.returncode!=0 and '23514' in r.stderr and 'fixture_reject_full_json' in r.stderr,'Expected storage constraint failure');need(state()==before,'Failed JSON storage partially committed CAS or ack');need(commit(candidate)=='applied','Whole candidate retry after rollback failed');passed('full JSON write failure rolls back installed CAS and dirty acknowledgment; complete retry succeeds')
sql(f"UPDATE messages SET read_at=statement_timestamp(),body='read and corrected' WHERE id='{mid}';");c=snapshot();need(c['summary']['unread_count']==0 and c['summary']['last_message_preview']=='read and corrected','Covered read/body compute wrong');need(commit(c)=='applied' and state()['summary']==compute(),'Read/body fields not published');passed('covered message read/body changes publish real unread and preview fields')
# This deliberately proves the current trigger is incomplete for real summary dependencies.
s=state();sql(f"UPDATE contacts SET first_name='Changed' WHERE id='{cid}';UPDATE properties SET status='prospect' WHERE id='{pid}';UPDATE messages SET from_address='+18165550333',status='queued' WHERE id='{mid}';")
need(state()['generation']==s['generation'] and compute()['exists'] is False and state()['summary']['exists'] is True,'Expected dependency gap was not reproduced');observations['uncovered_dependency_gap']={'dirty_generation':s['generation'],'stored_exists':True,'fresh_compute_exists':False,'updates':['contact name','property status','message from_address','message status']};passed('negative coverage proof: contact/property/route/status updates do not dirty current trigger despite changed real summary')
# A covered body mutation is an explicit fixture recovery, not invented fanout.
sql(f"UPDATE messages SET status='received',body='covered recovery' WHERE id='{mid}';");c=snapshot();need(c['summary']['contact_name']=='Changed Initial' and c['summary']['assignment_eligible'] is False and c['summary']['thread_customer_phone']=='+18165550333','Dependency recompute fields incorrect');need(commit(c)=='applied','Covered recovery failed');passed('explicit covered event recomputes and persists changed contact/property/route fields')
# Time alone can change eligibility without advancing dirty generation.
later=sql(f"SELECT ({lit(asof)}::timestamptz+interval '2160 hours')::text;");s=state();need(compute(later)['exists'] is False and state()==s,'Expiry-only gap not reproduced');observations['expiry_gap']={'stored_exists':True,'fresh_future_compute_exists':False,'generation_unchanged':True};passed('negative coverage proof: expiry requires scheduling; time alone does not dirty or replace stored summary')
sql(f"DELETE FROM messages WHERE id='{mid}';");tomb=snapshot();need(tomb['summary']['exists'] is False,'Deletion did not compute tombstone');need(commit(tomb)=='applied','Tombstone publication failed');deleted=state();need(deleted['summary']['exists'] is False and deleted['generation']==deleted['ack'],'Tombstone not stored/acknowledged');passed('deletion publishes full keyed tombstone and retains monotonic projection metadata')
sql(f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,created_at) VALUES('{mid}','{org}','{conv}','{cid}','{pid}','sms','inbound','received','returned',{lit(asof)}::timestamptz);");returned=snapshot();need(commit(returned)=='applied','Reinsert did not publish');need(state()['summary']['exists'] is True and int(state()['revision'])>int(deleted['revision']),'Reinsert reset projection history');need(commit(tomb)=='invalid_generation','Old tombstone resurrected after reinsert');passed('delete/reinsert restores summary with fresh generation/revision; stale tombstone rejected')
for role in ['authenticated','service_role']:
 r=sql(f"SET ROLE {role};SELECT inbox_t2_summary_worker.snapshot('{org}','{conv}',now());",False);need(r.returncode!=0 and '42501' in r.stderr and 'permission denied' in r.stderr,'Private worker accessible')
passed('worker-private snapshot denies authenticated/service roles')
need(hashes()==original,'Existing proof or compute functions changed');passed('all existing dirty/CAS/compute definitions preserved')
e={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checks':checks,'observations':observations,'org':org,'conversation':conv,'as_of':asof,'dependency_hashes':original,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'final_state':state(),'limits':['Private worker fixture only; owner-computed candidate is trusted, not client input','Existing dirty trigger lacks complete dependency fanout and expiry scheduling; explicit negative proofs recorded','Side table must only be published through this wrapper for these keys; old direct CAS does not update full JSON','No production migration/routes/auth/queue delivery or load guarantee']}
(P/'evidence.json').write_text(json.dumps(e,indent=2)+'\n');print(json.dumps({'passed':len(checks),'checks':checks},indent=2))
