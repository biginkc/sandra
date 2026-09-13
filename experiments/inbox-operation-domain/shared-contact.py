#!/usr/bin/env python3
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,runpy,sys
from pathlib import Path
P=Path(__file__).resolve().parent
concurrent=sys.argv[1:]==['--run-owned-fixture','--concurrent']
if not concurrent and sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit fixture required')
sys.argv=[str(P/'run-sms.py'),'--run-owned-fixture','--continue-installed'];f=runpy.run_path(str(P/'run-sms.py'))
for key in ['sql','need','uid','lit','o','u','a','c','p','conv','sibling']:globals()[key]=f[key]
conv2,m2,seq,e1,e2,prep,operation,item1,item2,s1,s2=[uid() for _ in range(11)]
# A fresh synthetic opt-in cycle gives this two-property operation its own real
# consent transition. Prior fixture evidence is preserved, not deleted.
sql(f"UPDATE contacts SET sms_opted_out=false,sms_opted_out_at=NULL WHERE id='{c}';INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES('{o}','{c}','sms','opt_in_informational','synthetic_new_cycle');UPDATE properties SET outreach_dispo=NULL WHERE id='{p}';INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body) VALUES('{m2}','{o}','{conv2}','{c}','{sibling}','sms','inbound','received','Shared homeowner');INSERT INTO sequences(id,org_id,name) VALUES('{seq}','{o}','Shared contact {seq}');INSERT INTO sequence_enrollments(id,org_id,property_id,sequence_id,status,next_run_at) VALUES('{e1}','{o}','{p}','{seq}','active',clock_timestamp()),('{e2}','{o}','{sibling}','{seq}','active',clock_timestamp())")
definition={'version':1,'steps':[{'type':'outcome','value':'opted_out'}]}
canonical=json.dumps({'purpose':'prepare_action','organizationId':o,'requesterId':u,'targets':sorted([{'kind':'conversation','id':conv},{'kind':'conversation','id':conv2}],key=lambda x:x['id']),'definition':definition,'savedAction':None},separators=(',',':'))
hash_=hashlib.sha256(b'sandra:inbox:action:v1\0'+canonical.encode()).hexdigest()
scope=json.loads(sql(f"SELECT jsonb_build_object('contact_id','{c}','revision',(SELECT revision::text FROM inbox_operation_domain.sms_scopes WHERE org_id='{o}' AND contact_id='{c}'),'property_ids',(SELECT jsonb_agg(id ORDER BY id) FROM properties WHERE org_id='{o}' AND homeowner_contact_id='{c}'),'enrollment_ids',(SELECT jsonb_agg(e.id ORDER BY e.id) FROM sequence_enrollments e JOIN properties p ON p.id=e.property_id AND p.org_id=e.org_id WHERE e.org_id='{o}' AND p.homeowner_contact_id='{c}' AND e.status='active'))"))
sql(f"INSERT INTO inbox_operations.preparations VALUES('{prep}','{o}','{u}',{lit(canonical)},'{hash_}',{lit(json.dumps(definition))},'{{}}',clock_timestamp()+interval '1 hour');INSERT INTO inbox_operations.operations(org_id,id,requester_id,idempotency_key,input_hash,preparation_id,definition) VALUES('{o}','{operation}','{u}','{uid()}','{hash_}','{prep}',{lit(json.dumps(definition))})")
for prop,conversation,item,step in [(p,conv,item1,s1),(sibling,conv2,item2,s2)]:
 req=[{'namespace':n,'key':[prop]} for n in ['property_identity','property_policy','property_outcome','property_assignment','property_reviews']]+[{'namespace':'membership_access','key':[u]}]+[{'namespace':n,'key':[c]} for n in ['contact_identity','contact_policy']]+[{'namespace':'contact_channel_consent','key':[c,'sms']}]
 # The new sibling has no review row yet: create a real resolved review to seed
 # its policy counter without making the summary depend on a pending review.
 if prop==sibling:sql(f"INSERT INTO ai_disposition_reviews(id,org_id,property_id,conversation_id,source_inbound_message_id,disposition,ai_reason,status,resolved_at,superseded_reason) VALUES('{uid()}','{o}','{prop}','{conversation}','{m2}','not_interested','Synthetic baseline','superseded',clock_timestamp(),'synthetic historical baseline')")
 policy=json.loads(sql(f"SELECT inbox_t2_policy.snapshot('{o}',{lit(json.dumps(req))})"));targets=[{'conversation_id':conversation,'revision':sql(f"SELECT revision FROM inbox_operation_domain.target_versions WHERE org_id='{o}' AND conversation_id='{conversation}'")}]
 deps={'policy':policy,'targets':targets,'sms_scope':scope}
 sql(f"INSERT INTO inbox_operations.items VALUES('{o}','{operation}','{item}','conversation','{conversation}','{{\"property_id\":\"{prop}\"}}',NULL);INSERT INTO inbox_operations.steps(org_id,operation_id,id,effect_key,ordinal,action,payload,dependencies) VALUES('{o}','{operation}','{step}','property:{prop}',0,'outcome','{{\"property_id\":\"{prop}\",\"value\":\"opted_out\"}}',{lit(json.dumps(deps))});INSERT INTO inbox_operations.item_steps VALUES('{o}','{operation}','{item}','{step}')")
g1=sql(f"SELECT inbox_operations.claim_step('{o}','{operation}','{s1}')");g2=sql(f"SELECT inbox_operations.claim_step('{o}','{operation}','{s2}')")
if concurrent:
 import sessions
 sessions.configure(f['D']+['exec','-i',f['N'],'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],sql)
 holder=sessions.Session();worker=sessions.Session()
 try:
  holder.barrier(f"BEGIN;SELECT revision FROM inbox_operation_domain.sms_scopes WHERE org_id='{o}' AND contact_id='{c}' FOR UPDATE;")
  worker.close(f"SELECT inbox_operation_domain.apply_property_step('{o}','{operation}','{s2}',{g2});")
  sessions.blocked(worker,holder)
  # The second effect must wait before owning its property or reading shared
  # receipts, so the first can finish without a property/scope inversion.
  holder.barrier(f"SELECT inbox_operation_domain.apply_property_step('{o}','{operation}','{s1}',{g1});")
  holder.close('COMMIT;');rc,out,err=holder.result();need(rc==0,err)
  first=next(json.loads(line) for line in out.splitlines() if line.startswith('{'))
  rc,out,err=worker.result();need(rc==0,err)
  second=next(json.loads(line) for line in out.splitlines() if line.startswith('{'))
 finally:
  for process in sessions.processes:process.stop()
else:
 first=json.loads(sql(f"SELECT inbox_operation_domain.apply_property_step('{o}','{operation}','{s1}',{g1})"))
 external=sql(f"BEGIN;UPDATE contacts SET sms_opted_out=false WHERE id='{c}';SELECT inbox_operation_domain.apply_property_step('{o}','{operation}','{s2}',{g2});COMMIT",False)
 need(external.returncode!=0 and 'Dependency conflict' in external.stderr,'Shared safety ignored external contact change: '+external.stderr)
 mismatch=sql(f"BEGIN;UPDATE inbox_operations.steps SET dependencies=jsonb_set(dependencies,'{{sms_scope,revision}}','\"999999\"') WHERE org_id='{o}' AND operation_id='{operation}' AND id='{s2}';SELECT inbox_operation_domain.apply_property_step('{o}','{operation}','{s2}',{g2});COMMIT",False)
 need(mismatch.returncode!=0 and 'Shared SMS preparation mismatch' in mismatch.stderr,'Shared safety ignored original scope mismatch')
 second=json.loads(sql(f"SELECT inbox_operation_domain.apply_property_step('{o}','{operation}','{s2}',{g2})"))
need(first['sms']['reused'] is False and second['sms']['reused'] is True,'Safety was not deduplicated')
need(sql(f"SELECT count(*) FROM properties WHERE id IN ('{p}','{sibling}') AND outreach_dispo='opted_out'")=='2','Both property outcomes missing')
need(sql(f"SELECT count(*) FROM inbox_operations.receipts WHERE org_id='{o}' AND operation_id='{operation}'")=='2','Two property receipts missing')
need(sql(f"SELECT count(*) FROM inbox_operation_domain.shared_sms_receipts WHERE org_id='{o}' AND operation_id='{operation}'")=='1','Safety receipt duplicated')
need(sql(f"SELECT count(*) FROM consent_events WHERE source_detail->>'operationStepId' IN ('{s1}','{s2}')")=='1','Consent duplicated')
need(sql(f"SELECT count(*) FROM sequence_enrollments WHERE id IN ('{e1}','{e2}') AND status='opted_out'")=='2','Shared enrollment stop incomplete')
(P/('shared-contact-concurrent-evidence.json' if concurrent else 'shared-contact-evidence.json')).write_text(json.dumps({'checks':[{'name':name,'passed':True} for name in ['two properties share one contact safety effect and both complete',*(['concurrent second property waits before source locks and reads committed safety receipt'] if concurrent else ['external shared contact edit still conflicts','different original scope cannot reuse safety receipt']),'one consent event and one immutable safety receipt','both active enrollments stopped']],'source_hashes':{name:hashlib.sha256((P/name).read_bytes()).hexdigest() for name in ['restrictive-scope.sql','restrictive-effect.sql','restrictive-apply.sql']},'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'fixture_operation_id':operation},indent=2)+'\n')
print('Two-property same-contact safety deduplication and strict conflict checks passed')
