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
  await db.query(sql("20261030300000_routing_v2_outbox_provider_fence.sql"));
  inbound=(await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body) values($1,$2,$3,'inbound','sms','Who?') returning id",[org,property,contact])).rows[0].id;
});
afterEach(()=>db.query("rollback"));

async function intent(kind="reply",payload:Record<string,unknown>={key:"identity"}) {
 await db.query("select route_reply_transition($1,$2,$3)",[inbound,property,JSON.stringify({sequence_key:null,outbox:[{kind,payload}]})]);
 return (await db.query("select id from routing_v2_outbox where inbound_message_id=$1",[inbound])).rows[0].id;
}
const rpc=async(name:string,id:string)=>(await db.query(`select ${name}($1) as r`,[id])).rows[0].r;
const check=async(id:string)=>(await db.query("select routing_v2_check_authorized_outbox_send($1,$2,$3) as r",[id,property,inbound])).rows[0].r;
async function authorize(id:string){expect(await rpc("routing_v2_claim_outbox",id)).toBe("ok");expect(await rpc("routing_v2_authorize_outbox_send",id)).toBe("ok");}
describe("final outbox provider fence",()=>{
 it("requires authorization and does not authorize a retry",async()=>{
  const id=await intent();expect(await check(id)).toBe("not_claimed");await rpc("routing_v2_claim_outbox",id);expect(await check(id)).toBe("not_authorized");await rpc("routing_v2_authorize_outbox_send",id);expect(await check(id)).toBe("ok");expect(await rpc("routing_v2_authorize_outbox_send",id)).toBe("already_authorized");
 });
 it("refuses a flag flip after initial authorization",async()=>{
  const id=await intent();await authorize(id);await db.query("update ai_responder_configs set routing_v2_flags='{}' where org_id=$1",[org]);expect(await check(id)).toBe("flag_off");
 });
 it("refuses a newer raw inbound before that inbound transitions",async()=>{
  const id=await intent();await authorize(id);await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,created_at) values($1,$2,$3,'inbound','sms','new reply',now()+interval '1 second')",[org,property,contact]);expect(await check(id)).toBe("superseded");
 });
 it("rechecks conditional alert flags at delivery while keeping unconditional alerts",async()=>{
  const id=await intent("alert",{reason:"hot_yes",when_time_only_off:true});await authorize(id);expect(await check(id)).toBe("ok");await db.query("update ai_responder_configs set routing_v2_flags=routing_v2_flags || '{\"alert_on_time_only\":true}'::jsonb where org_id=$1",[org]);expect(await check(id)).toBe("time_only_alert_disabled");
 });
 it("binds the intent to the current send identity",async()=>{
  const id=await intent();await authorize(id);expect((await db.query("select routing_v2_check_authorized_outbox_send($1,$2,$3) as r",[id,property,randomUUID()])).rows[0].r).toBe("identity_mismatch");expect(await check(id)).toBe("ok");
 });
});
