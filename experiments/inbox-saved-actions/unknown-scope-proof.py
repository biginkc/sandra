import subprocess, sys, uuid, json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'experiments/inbox-projection/fixture'))
from guards import validate_container, validate_cron
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N='sandra-inbox-projection-t2-db'

# Guard before any DDL or fixture DML: this is the owned synthetic T2
# container only, cron must be disabled, and the entire proof rolls back.
validate_container(json.loads(subprocess.check_output(D+['inspect',N], text=True))[0])
def probe(sql):
    r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'], input=sql, text=True, capture_output=True, timeout=20)
    if r.returncode: raise RuntimeError(r.stderr)
    return r.stdout.strip()
validate_cron(probe('SHOW cron.launch_active_jobs'))
if probe("SELECT marker FROM inbox_t2_fixture.identity") != 'sandra-inbox-projection-t2-owned-synthetic':
    raise RuntimeError('Wrong fixture marker')
root=ROOT
source=(root/'experiments/inbox-operation-domain/restrictive-apply.sql').read_text()
def u(): return str(uuid.uuid4())
def q(v): return "'"+str(v).replace("'","''")+"'"
o,req,owner,raw=[u(),u(),u(),'+15550001111']
prep_d,op_d,item_d,step_d=[u() for _ in range(4)]
prep_r,op_r,item_r,step_r=[u() for _ in range(4)]
m1,m2,m3,m4,m5,m6=[u() for _ in range(6)]
c1,c2,c3,c4,c5,c6=[u() for _ in range(6)]
body=f"""
DECLARE
 org uuid:={q(o)}; requester uuid:={q(req)}; owner_id uuid:={q(owner)}; sender text:={q(raw)};
 group_id uuid; rev bigint; payload jsonb; canonical jsonb; result jsonb;
BEGIN
 INSERT INTO organizations(id,name) VALUES(org,'rollback unknown proof');
 INSERT INTO auth.users(id,email) VALUES(owner_id,owner_id::text||'@example.invalid'),(requester,requester::text||'@example.invalid');
 INSERT INTO memberships(org_id,user_id,role,access_status) VALUES(org,owner_id,'owner','active'),(org,requester,'member','active');
 -- Two visible unknown messages are the accepted dismiss scope.
 INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body,from_address,dismissed_at)
 VALUES ({q(m1)},org,{q(c1)},'sms','inbound','received','dismiss one',sender,NULL),
        ({q(m2)},org,{q(c2)},'sms','inbound','received','dismiss two',sender,NULL);
 SELECT sender_group_id INTO STRICT group_id FROM inbox_t2_message_capture.sender_groups WHERE org_id=org AND raw_sender=sender;
 SELECT revision INTO STRICT rev FROM inbox_t2_message_capture.versions WHERE org_id=org AND namespace='unknown_action' AND target_id=group_id;
 payload:=jsonb_build_object('sender_group_id',group_id,'raw_sender',sender,'revision',rev::text,'message_ids',jsonb_build_array(to_jsonb({q(m1)}::text),to_jsonb({q(m2)}::text)));
 canonical:=jsonb_build_object('purpose','prepare_action','organizationId',org::text,'requesterId',requester::text,'targets',jsonb_build_array(jsonb_build_object('kind','unknown_sender_group','id',group_id::text)),'definition',jsonb_build_object('version',1,'steps',jsonb_build_array(jsonb_build_object('type','dismiss_unknown'))),'savedAction',NULL);
 INSERT INTO inbox_operations.preparations(id,org_id,requester_id,canonical_input,input_hash,definition,snapshot,expires_at)
 VALUES ({q(prep_d)},org,requester,canonical::text,encode(sha256(convert_to('sandra:inbox:action:v1','UTF8')||decode('00','hex')||convert_to(canonical::text,'UTF8')),'hex'),canonical->'definition',jsonb_build_object('items',jsonb_build_array()),clock_timestamp()+interval '1 hour');
 INSERT INTO inbox_operations.operations(org_id,id,requester_id,idempotency_key,input_hash,preparation_id,definition)
 SELECT org,{q(op_d)},requester,{q(u())},input_hash,id,definition FROM inbox_operations.preparations WHERE id={q(prep_d)};
 INSERT INTO inbox_operations.items VALUES(org,{q(op_d)},{q(item_d)},'unknown_sender_group',group_id,jsonb_build_object('unknown_action',payload),NULL);
 INSERT INTO inbox_operations.steps(org_id,operation_id,id,effect_key,ordinal,action,payload,dependencies)
 VALUES(org,{q(op_d)}, {q(step_d)},'unknown:'||group_id::text,0,'dismiss_unknown',payload,jsonb_build_object('unknown_action',payload));
 INSERT INTO inbox_operations.item_steps VALUES(org,{q(op_d)},{q(item_d)},{q(step_d)});
 -- A new arrival advances the sender-group counter, but is outside the frozen IDs.
 INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body,from_address,dismissed_at)
 VALUES ({q(m3)},org,{q(c3)},'sms','inbound','received','new arrival',sender,NULL);
 result:=inbox_operation_domain.apply_unknown_step(org,{q(op_d)},{q(step_d)},inbox_operations.claim_step(org,{q(op_d)},{q(step_d)}));
 IF (result->>'changed_count')::integer<>2 OR (SELECT dismissed_at IS NOT NULL FROM messages WHERE id={q(m1)}) IS NOT TRUE OR (SELECT dismissed_at IS NOT NULL FROM messages WHERE id={q(m2)}) IS NOT TRUE OR (SELECT dismissed_at IS NULL FROM messages WHERE id={q(m3)}) IS NOT TRUE THEN RAISE EXCEPTION 'dismiss scope/new arrival failed: %',result; END IF;
 RAISE NOTICE 'PASS dismiss uses frozen original IDs; new arrival remains visible';
 -- Two dismissed messages are the accepted restore scope.
 INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body,from_address,dismissed_at)
 VALUES ({q(m4)},org,{q(c4)},'sms','inbound','received','restore one',sender,clock_timestamp()),
        ({q(m5)},org,{q(c5)},'sms','inbound','received','restore two',sender,clock_timestamp());
 SELECT revision INTO STRICT rev FROM inbox_t2_message_capture.versions WHERE org_id=org AND namespace='unknown_action' AND target_id=group_id;
 payload:=jsonb_build_object('sender_group_id',group_id,'raw_sender',sender,'revision',rev::text,'message_ids',jsonb_build_array(to_jsonb({q(m4)}::text),to_jsonb({q(m5)}::text)));
 canonical:=jsonb_build_object('purpose','prepare_action','organizationId',org::text,'requesterId',requester::text,'targets',jsonb_build_array(jsonb_build_object('kind','unknown_sender_group','id',group_id::text)),'definition',jsonb_build_object('version',1,'steps',jsonb_build_array(jsonb_build_object('type','restore_unknown'))),'savedAction',NULL);
 INSERT INTO inbox_operations.preparations(id,org_id,requester_id,canonical_input,input_hash,definition,snapshot,expires_at)
 VALUES ({q(prep_r)},org,requester,canonical::text,encode(sha256(convert_to('sandra:inbox:action:v1','UTF8')||decode('00','hex')||convert_to(canonical::text,'UTF8')),'hex'),canonical->'definition',jsonb_build_object('items',jsonb_build_array()),clock_timestamp()+interval '1 hour');
 INSERT INTO inbox_operations.operations(org_id,id,requester_id,idempotency_key,input_hash,preparation_id,definition)
 SELECT org,{q(op_r)},requester,{q(u())},input_hash,id,definition FROM inbox_operations.preparations WHERE id={q(prep_r)};
 INSERT INTO inbox_operations.items VALUES(org,{q(op_r)},{q(item_r)},'unknown_sender_group',group_id,jsonb_build_object('unknown_action',payload),NULL);
 INSERT INTO inbox_operations.steps(org_id,operation_id,id,effect_key,ordinal,action,payload,dependencies)
 VALUES(org,{q(op_r)}, {q(step_r)},'unknown:'||group_id::text,0,'restore_unknown',payload,jsonb_build_object('unknown_action',payload));
 INSERT INTO inbox_operations.item_steps VALUES(org,{q(op_r)},{q(item_r)},{q(step_r)});
 -- A newly arrived dismissed row advances the counter but must remain dismissed.
 INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body,from_address,dismissed_at)
 VALUES ({q(m6)},org,{q(c6)},'sms','inbound','received','new dismissed arrival',sender,clock_timestamp());
 result:=inbox_operation_domain.apply_unknown_step(org,{q(op_r)},{q(step_r)},inbox_operations.claim_step(org,{q(op_r)},{q(step_r)}));
 IF (result->>'changed_count')::integer<>2 OR (SELECT dismissed_at IS NULL FROM messages WHERE id={q(m4)}) IS NOT TRUE OR (SELECT dismissed_at IS NULL FROM messages WHERE id={q(m5)}) IS NOT TRUE OR (SELECT dismissed_at IS NOT NULL FROM messages WHERE id={q(m6)}) IS NOT TRUE THEN RAISE EXCEPTION 'restore scope/new arrival failed: %',result; END IF;
 RAISE NOTICE 'PASS restore restores frozen original IDs; new dismissed arrival remains dismissed';
 RAISE NOTICE 'UNKNOWN SNAPSHOT: ALL GREEN';
END
"""
if 'COMMIT;' in source: raise RuntimeError('Candidate source must be rollback-safe')
sql="SET lock_timeout='2s';SET statement_timeout='20s';BEGIN;"+source+'DO $unknown$'+body+'$unknown$;ROLLBACK;'
r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],input=sql,text=True,capture_output=True,timeout=60)
print(r.stdout)
print(r.stderr)
if r.returncode: raise SystemExit(r.returncode)
