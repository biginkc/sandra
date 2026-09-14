#!/usr/bin/env python3
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,runpy,sys
from pathlib import Path
P=Path(__file__).resolve().parent
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
sys.argv=[str(P/'run-sms.py'),'--run-owned-fixture','--continue-installed']
f=runpy.run_path(str(P/'run-sms.py'));sql=f['sql'];uid=f['uid'];o=f['o'];c=f['c']
p,seq,e=uid(),uid(),uid()
sql(f"INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{p}','{o}','Future enrollment {p}','MO','{c}');INSERT INTO sequences(id,org_id,name) VALUES('{seq}','{o}','Future SMS {seq}');INSERT INTO sequence_enrollments(id,org_id,property_id,sequence_id,status,next_run_at) VALUES('{e}','{o}','{p}','{seq}','active',clock_timestamp())")
result=json.loads(sql(f"SELECT jsonb_build_object('organization_id','{o}','property_id','{p}','contact_id','{c}','enrollment_id','{e}','enrollment_status',(SELECT status FROM sequence_enrollments WHERE id='{e}'),'properties',(SELECT jsonb_agg(to_jsonb(q)) FROM (SELECT id,org_id,homeowner_contact_id,is_training,state,outreach_dispo FROM properties WHERE org_id='{o}' AND homeowner_contact_id='{c}') q),'contacts',(SELECT jsonb_agg(to_jsonb(q)) FROM (SELECT id,org_id,do_not_contact,sms_opted_out,phone_1,phone_1_type,phone_2,phone_2_type,phone_3,phone_3_type FROM contacts WHERE id='{c}' AND org_id='{o}') q),'consent_events',(SELECT jsonb_agg(to_jsonb(q)) FROM (SELECT contact_id,channel,event_type,occurred_at FROM consent_events WHERE contact_id='{c}' AND org_id='{o}' ORDER BY occurred_at DESC) q))"))
f['need'](result['enrollment_status']=='active','Actual future enrollment was not active')
f['need'](next(row for row in result['properties'] if row['id']==p)['outreach_dispo'] is None,'New property outcome not neutral')
result['runner_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
(P/'future-enrollment-snapshot.json').write_text(json.dumps(result,indent=2)+'\n')
print('Actual later active enrollment exists; neutral property and current consent snapshot exported')
