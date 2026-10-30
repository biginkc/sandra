import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
const db=new Client({connectionString:requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!)});
const sql=(name:string)=>readFileSync(path.join(__dirname,name),"utf8").replace(/^\s*(begin|commit);\s*$/gim,"");
let org:string,property:string,contact:string,inbound:string,sequence:string;
beforeAll(()=>db.connect());afterAll(()=>db.end());
beforeEach(async()=>{
  await db.query("begin"); org=randomUUID();
  await db.query("insert into organizations(id,name) values($1,'skip step test')",[org]);
  await db.query("insert into ai_responder_configs(org_id,system_prompt,routing_v2_flags) values($1,'test',$2)",[org,JSON.stringify({questions_live:true,replies:true,drips:true,canary_percent:100})]);
  contact=(await db.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'Test','+18165550100','mobile') returning id",[org])).rows[0].id;
  property=(await db.query("insert into properties(org_id,address,state,status,homeowner_contact_id) values($1,'1 Test St','MO','new_lead',$2) returning id",[org,contact])).rows[0].id;
  sequence=(await db.query("insert into sequences(org_id,name,active) values($1,'Asked who is texting',true) returning id",[org])).rows[0].id;
  await db.query("insert into sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values($1,0,0,'send_sms','Identity'),($1,1,1440,'send_sms','Next day')",[sequence]);
  await db.query(sql("20261030270000_routing_v2_legacy_drip_snapshots.sql"));
  await db.query(sql("20261030280000_routing_v2_skip_first_step.sql"));
  await db.query(sql("20261030290000_routing_v2_live_transition_guard.sql"));
  inbound=(await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body) values($1,$2,$3,'inbound','sms','Who?') returning id",[org,property,contact])).rows[0].id;
});
afterEach(()=>db.query("rollback"));

const plan={road:"who_reply_drip",sequence_key:"asked_who",skip_first_step:true,outbox:[{kind:"reply",payload:{key:"identity"}}]};
const run=async()=> (await db.query("select routing_v2_apply_live_transition($1,$2,$3) as r",[inbound,property,JSON.stringify({...plan,contact_id:contact})])).rows[0].r;
async function evidence(steps:unknown[]=[{kind:"reply",key:"identity"},{kind:"drip",drip:"Asked who is texting",skipFirstStep:true}]) {
  await db.query("insert into routing_v2_live_decisions(org_id,property_id,inbound_message_id,status,road,expected_revision,action) select $1,$2,$3,'decided','who_reply_drip',decision_context_revision,$4 from properties where id=$2",[org,property,inbound,JSON.stringify({road:"who_reply_drip",steps})]);
}
describe("live evidence guarded transition",()=>{
  it("requires live evidence, applies once and replays after revision changes",async()=>{
    expect(await run()).toMatchObject({outcome:"evidence_missing"});
    await evidence();const result=await run();expect(result.outcome).toBe("applied");
    await db.query("update properties set decision_context_revision=decision_context_revision+1 where id=$1",[property]);
    expect(await run()).toMatchObject({replayed:true,new_enrollment_id:result.new_enrollment_id});
  });
  it("refuses stale classification without retiring or creating anything",async()=>{
    await evidence();await db.query("update properties set decision_context_revision=decision_context_revision+1 where id=$1",[property]);
    expect(await run()).toMatchObject({outcome:"context_changed"});
    expect((await db.query("select count(*)::int as n from routing_v2_reply_transitions where inbound_message_id=$1",[inbound])).rows[0].n).toBe(0);
  });
  it("refuses holds even if a caller passes a normal-send plan",async()=>{
    await evidence([{kind:"hold",reason:"asked_stop"}]);
    expect(await run()).toMatchObject({outcome:"specialized_action_required"});
  });
  it("rejects a newer inbound even when evidence was recorded at the current revision",async()=>{
    await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,created_at) values($1,$2,$3,'inbound','sms','Newer',now()+interval '1 second')",[org,property,contact]);
    await evidence();expect(await run()).toMatchObject({outcome:"superseded"});
  });
  it("does not accept another contact for the same evidence",async()=>{
    await evidence();const result=(await db.query("select routing_v2_apply_live_transition($1,$2,$3) as r",[inbound,property,JSON.stringify({...plan,contact_id:randomUUID()})])).rows[0].r;
    expect(result).toMatchObject({outcome:"evidence_mismatch"});
  });
  it("denies browser roles execution",async()=>{
    expect((await db.query("select has_function_privilege('authenticated','routing_v2_apply_live_transition(uuid,uuid,jsonb)','EXECUTE') as user_allowed,has_function_privilege('anon','routing_v2_apply_live_transition(uuid,uuid,jsonb)','EXECUTE') as anon_allowed,has_function_privilege('service_role','routing_v2_apply_live_transition(uuid,uuid,jsonb)','EXECUTE') as service_allowed")).rows[0]).toEqual({user_allowed:false,anon_allowed:false,service_allowed:true});
  });
});
