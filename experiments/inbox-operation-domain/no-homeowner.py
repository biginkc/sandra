#!/usr/bin/env python3
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,runpy,sys
from pathlib import Path
P=Path(__file__).resolve().parent
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit fixture required')
sys.argv=[str(P/'run-sms.py'),'--run-owned-fixture','--continue-installed'];f=runpy.run_path(str(P/'run-sms.py'))
for key in ['sql','need','uid','lit','o','u','p','conv','op','item','req']:globals()[key]=f[key]
sid=uid()
# Roll back this additional case to preserve the synthetic baseline for sibling
# proofs. The real adapter and receipt checks execute before that rollback.
sql(f"""BEGIN;
UPDATE properties SET homeowner_contact_id=NULL WHERE org_id='{o}' AND id='{p}';
INSERT INTO inbox_operations.steps(org_id,operation_id,id,effect_key,ordinal,action,payload,dependencies)
 VALUES('{o}','{op}','{sid}','property:{p}',3,'outcome','{{"property_id":"{p}","value":"opted_out"}}',
 jsonb_build_object('policy',inbox_t2_policy.snapshot('{o}',{lit(json.dumps(req))}),'targets',jsonb_build_array(jsonb_build_object('conversation_id','{conv}','revision',(SELECT revision::text FROM inbox_operation_domain.target_versions WHERE org_id='{o}' AND conversation_id='{conv}'))),'sms_scope',NULL));
INSERT INTO inbox_operations.item_steps VALUES('{o}','{op}','{item}','{sid}');
DO $$ DECLARE r jsonb;g bigint;BEGIN
 g:=inbox_operations.claim_step('{o}','{op}','{sid}');
 r:=inbox_operation_domain.apply_property_step('{o}','{op}','{sid}',g);
 IF r->'sms'->>'contact_id' IS NOT NULL OR r->'after'->>'outcome'<>'opted_out' OR NOT EXISTS(SELECT 1 FROM inbox_operations.receipts WHERE org_id='{o}' AND operation_id='{op}' AND step_id='{sid}') THEN RAISE EXCEPTION 'No-homeowner effect contract failed';END IF;
END $$;ROLLBACK;""")
need(sql(f"SELECT homeowner_contact_id IS NOT NULL FROM properties WHERE id='{p}'")=='t','Fixture rollback failed')
(P/'no-homeowner-evidence.json').write_text(json.dumps({'check':'Actual outcome without homeowner produces no-contact result and receipt; test transaction rolled back','passed':True,'source_hashes':{name:hashlib.sha256((P/name).read_bytes()).hexdigest() for name in ['restrictive-effect.sql','restrictive-apply.sql']},'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2)+'\n')
print('Actual no-homeowner outcome/receipt contract passed')
