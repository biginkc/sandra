import json, subprocess, sys, uuid
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
# DO block uses only rollback-scoped fixture rows and calls the candidate adapters
# after installing their source in the same transaction.
o,u_req,u_assign,c,m,conv,prep,op1,op2,item1,item2,s11,s12,s21,s22=[u() for _ in range(15)]
def deps(vector, rev):
    return json.dumps({'policy':vector,'targets':[{'conversation_id':conv,'revision':str(rev)}]}, separators=(',',':'))
def canonical(org, req, definition):
    obj={'purpose':'prepare_action','organizationId':org,'requesterId':req,'targets':[{'kind':'conversation','id':conv}], 'definition':definition,'savedAction':None}
    return json.dumps(obj,separators=(',',':'))
def sql_uuid(x): return q(x)
def make_op(org, req, op, prep, item, s1, s2, first_action, first_payload, second_action, second_payload, vector, rev):
    definition={'version':1,'steps':[{'type':first_action},{'type':second_action}]}
    can=canonical(org,req,definition)
    # hash in SQL exactly as the preparation check
    return f"""
INSERT INTO inbox_operations.preparations(id,org_id,requester_id,canonical_input,input_hash,definition,snapshot,expires_at)
VALUES ({q(prep)},{q(org)},{q(req)},{q(can)},encode(sha256(convert_to('sandra:inbox:action:v1','UTF8')||decode('00','hex')||convert_to({q(can)},'UTF8')),'hex'),{q(json.dumps(definition,separators=(',',':')))}::jsonb,'{{}}'::jsonb,clock_timestamp()+interval '1 hour');
INSERT INTO inbox_operations.operations(org_id,id,requester_id,idempotency_key,input_hash,preparation_id,definition)
SELECT {q(org)},{q(op)},{q(req)},{q(u())},input_hash,id,definition FROM inbox_operations.preparations WHERE id={q(prep)};
INSERT INTO inbox_operations.items(org_id,operation_id,id,target_kind,target_id,resolution,exclusion_code)
VALUES ({q(org)},{q(op)},{q(item)},'conversation',{q(conv)},jsonb_build_object('property_id',{q(p)}),NULL);
INSERT INTO inbox_operations.steps(org_id,operation_id,id,effect_key,ordinal,action,payload,dependencies,predecessor_id)
VALUES ({q(org)},{q(op)},{q(s1)},'property:{p}',0,{q(first_action)},{q(json.dumps(first_payload,separators=(',',':')))}::jsonb,{q(deps(vector,rev))}::jsonb,NULL),
       ({q(org)},{q(op)},{q(s2)},'property:{p}',1,{q(second_action)},{q(json.dumps(second_payload,separators=(',',':')))}::jsonb,{q(deps(vector,rev))}::jsonb,{q(s1)});
INSERT INTO inbox_operations.item_steps(org_id,operation_id,item_id,step_id) VALUES ({q(org)},{q(op)},{q(item)},{q(s1)}),({q(org)},{q(op)},{q(item)},{q(s2)});
""".replace('{p}',p)
# p is assigned below; build after initialization
p=u()
review=u()
def call_step(org,op,step,fn):
    return f"SELECT inbox_operation_domain.{fn}({q(org)},{q(op)},{q(step)},inbox_operations.claim_step({q(org)},{q(op)},{q(step)}));"
# Validate every assertion in one rollback-only DO. Use psql variable literals generated in advance.
vector_expr=f"inbox_t2_policy.snapshot({q(o)},jsonb_build_array(" + ','.join([f"jsonb_build_object('namespace',{q(n)},'key',jsonb_build_array({q(p)}))" for n in ['property_identity','property_policy','property_outcome','property_assignment','property_reviews']]+[f"jsonb_build_object('namespace','membership_access','key',jsonb_build_array({q(u_req)}))",f"jsonb_build_object('namespace','membership_access','key',jsonb_build_array({q(u_assign)}))"]) + "))"
# We cannot put a query result into JSON literal in Python; use a DO variable.
first_definition={'version':1,'steps':[{'type':'promote'},{'type':'assign','userId':u_assign}]}
second_definition={'version':1,'steps':[{'type':'outcome','value':'nurture'},{'type':'promote'}]}
# Definitions are only immutable prep metadata in this direct durable adapter proof.
body=f"""
DECLARE
 req uuid:={q(u_req)}; assignee uuid:={q(u_assign)}; org uuid:={q(o)}; property_id uuid:={q(p)}; conversation uuid:={q(conv)};
 policy jsonb; rev bigint; result jsonb; first_result jsonb; second_result jsonb;
BEGIN
 -- Owner first, requester second preserves the fixture's final-owner guard.
 INSERT INTO organizations(id,name) VALUES (org,'rollback combo proof');
 INSERT INTO auth.users(id,email) VALUES (assignee,assignee::text||'@example.invalid'),(req,req::text||'@example.invalid');
 INSERT INTO memberships(org_id,user_id,role,access_status) VALUES(org,assignee,'owner','active'),(org,req,'member','active');
 INSERT INTO contacts(id,org_id,first_name) VALUES ({q(c)},org,'Combo');
 INSERT INTO properties(id,org_id,address,state,homeowner_contact_id,status) VALUES(property_id,org,'Combo property','MO',{q(c)},'prospect');
 INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body) VALUES ({q(m)},org,{q(conv)},{q(c)},property_id,'sms','inbound','received','Combo proof');
 INSERT INTO ai_disposition_reviews(id,org_id,property_id,conversation_id,source_inbound_message_id,disposition,ai_reason) VALUES ({q(review)},org,property_id,conversation,{q(m)},'not_interested','Combo proof');
 SELECT revision INTO rev FROM inbox_operation_domain.target_versions WHERE org_id=org AND conversation_id=conversation;
 IF rev IS NULL THEN RAISE EXCEPTION 'target revision not captured'; END IF;
 policy:={vector_expr};
 IF policy->>'org_id' IS DISTINCT FROM org::text THEN RAISE EXCEPTION 'policy baseline missing'; END IF;
 -- Promote -> Assign: promotion receipt must carry target_revisions and property_policy,
 -- then assignment must consume both and finish successfully.
 INSERT INTO inbox_operations.preparations(id,org_id,requester_id,canonical_input,input_hash,definition,snapshot,expires_at)
 VALUES ({q(prep)},{q(o)},{q(u_req)},{q(canonical(o,u_req,first_definition))},encode(sha256(convert_to('sandra:inbox:action:v1','UTF8')||decode('00','hex')||convert_to({q(canonical(o,u_req,first_definition))},'UTF8')),'hex'),{q(json.dumps(first_definition,separators=(',',':')))}::jsonb,'{{}}'::jsonb,clock_timestamp()+interval '1 hour');
 INSERT INTO inbox_operations.operations(org_id,id,requester_id,idempotency_key,input_hash,preparation_id,definition)
 SELECT org,{q(op1)},req,{q(u())},input_hash,id,definition FROM inbox_operations.preparations WHERE id={q(prep)};
 INSERT INTO inbox_operations.items VALUES(org,{q(op1)},{q(item1)},'conversation',conversation,jsonb_build_object('property_id',property_id),NULL);
 INSERT INTO inbox_operations.steps(org_id,operation_id,id,effect_key,ordinal,action,payload,dependencies,predecessor_id)
 VALUES(org,{q(op1)},{q(s11)},'property:'||property_id::text,0,'promote',jsonb_build_object('property_id',property_id),jsonb_build_object('policy',policy,'targets',jsonb_build_array(jsonb_build_object('conversation_id',conversation,'revision',rev::text))),NULL),
       (org,{q(op1)},{q(s12)},'property:'||property_id::text,1,'assign',jsonb_build_object('property_id',property_id,'user_id',assignee),jsonb_build_object('policy',policy,'targets',jsonb_build_array(jsonb_build_object('conversation_id',conversation,'revision',rev::text))),{q(s11)});
 INSERT INTO inbox_operations.item_steps VALUES(org,{q(op1)},{q(item1)},{q(s11)}),(org,{q(op1)},{q(item1)},{q(s12)});
 result:=inbox_operation_domain.apply_promotion_step(org,{q(op1)},{q(s11)},inbox_operations.claim_step(org,{q(op1)},{q(s11)}));
 IF result->>'outcome' IS DISTINCT FROM 'promoted' OR result->>'changed' IS DISTINCT FROM 'true' OR jsonb_typeof(result->'target_revisions') IS DISTINCT FROM 'array' OR jsonb_typeof(result->'revised_dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'promote receipt missing predecessor vectors: %',result; END IF;
 first_result:=inbox_operation_domain.apply_property_step(org,{q(op1)},{q(s12)},inbox_operations.claim_step(org,{q(op1)},{q(s12)}));
 IF first_result->>'action' IS DISTINCT FROM 'assign' OR first_result->>'changed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'promote to assign failed: %',first_result; END IF;
 IF NOT EXISTS(SELECT 1 FROM properties WHERE id=property_id AND status='new_lead' AND assigned_user_id=assignee) THEN RAISE EXCEPTION 'promote to assign canonical state missing'; END IF;
 RAISE NOTICE 'PASS Promote->Assign carried target_revisions + property_policy and assigned after promotion';
 -- Outcome -> Promote: reset canonical status in the rollback transaction, take a fresh
 -- policy snapshot, and prove promotion rebases the outcome receipt's property_outcome.
 UPDATE properties SET status='prospect',qualified_at=NULL,qualified_by=NULL,assigned_user_id=NULL,outreach_dispo=NULL,updated_at=clock_timestamp() WHERE id=property_id;
 SELECT revision INTO rev FROM inbox_operation_domain.target_versions WHERE org_id=org AND conversation_id=conversation;
 policy:={vector_expr};
 INSERT INTO inbox_operations.preparations(id,org_id,requester_id,canonical_input,input_hash,definition,snapshot,expires_at)
 VALUES ({q(op2)},{q(o)},{q(u_req)},{q(canonical(o,u_req,second_definition))},encode(sha256(convert_to('sandra:inbox:action:v1','UTF8')||decode('00','hex')||convert_to({q(canonical(o,u_req,second_definition))},'UTF8')),'hex'),{q(json.dumps(second_definition,separators=(',',':')))}::jsonb,'{{}}'::jsonb,clock_timestamp()+interval '1 hour');
 INSERT INTO inbox_operations.operations(org_id,id,requester_id,idempotency_key,input_hash,preparation_id,definition)
 SELECT org,{q(op2)},req,{q(u())},input_hash,id,definition FROM inbox_operations.preparations WHERE id={q(op2)};
 INSERT INTO inbox_operations.items VALUES(org,{q(op2)},{q(item2)},'conversation',conversation,jsonb_build_object('property_id',property_id),NULL);
 INSERT INTO inbox_operations.steps(org_id,operation_id,id,effect_key,ordinal,action,payload,dependencies,predecessor_id)
 VALUES(org,{q(op2)},{q(s21)},'property:'||property_id::text,0,'outcome',jsonb_build_object('property_id',property_id,'value','nurture'),jsonb_build_object('policy',policy,'targets',jsonb_build_array(jsonb_build_object('conversation_id',conversation,'revision',rev::text))),NULL),
       (org,{q(op2)},{q(s22)},'property:'||property_id::text,1,'promote',jsonb_build_object('property_id',property_id),jsonb_build_object('policy',policy,'targets',jsonb_build_array(jsonb_build_object('conversation_id',conversation,'revision',rev::text))),{q(s21)});
 INSERT INTO inbox_operations.item_steps VALUES(org,{q(op2)},{q(item2)},{q(s21)}),(org,{q(op2)},{q(item2)},{q(s22)});
 result:=inbox_operation_domain.apply_property_step(org,{q(op2)},{q(s21)},inbox_operations.claim_step(org,{q(op2)},{q(s21)}));
 IF result->>'action' IS DISTINCT FROM 'outcome' OR result->>'changed' IS DISTINCT FROM 'true' OR jsonb_typeof(result->'target_revisions') IS DISTINCT FROM 'array' OR jsonb_typeof(result->'revised_dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'outcome receipt missing predecessor vectors: %',result; END IF;
 second_result:=inbox_operation_domain.apply_promotion_step(org,{q(op2)},{q(s22)},inbox_operations.claim_step(org,{q(op2)},{q(s22)}));
 IF second_result->>'outcome' IS DISTINCT FROM 'promoted' OR second_result->>'changed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'outcome to promote failed: %',second_result; END IF;
 IF NOT EXISTS(SELECT 1 FROM properties WHERE id=property_id AND status='new_lead' AND outreach_dispo='nurture') THEN RAISE EXCEPTION 'outcome to promote canonical state missing'; END IF;
 RAISE NOTICE 'PASS Outcome->Promote rebased property_outcome and promoted after outcome';
 RAISE NOTICE 'PROMOTION COMBOS: ALL GREEN';
END
"""
if 'COMMIT;' in source: raise RuntimeError('Candidate source must be rollback-safe')
sql="SET lock_timeout='2s';SET statement_timeout='20s';BEGIN;"+source+'DO $combo$'+body+'$combo$;ROLLBACK;'
r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],input=sql,text=True,capture_output=True,timeout=60)
print(r.stdout)
print(r.stderr)
if r.returncode: raise SystemExit(r.returncode)
