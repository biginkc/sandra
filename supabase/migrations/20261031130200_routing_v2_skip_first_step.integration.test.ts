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
  await db.query(sql("20261031130100_routing_v2_legacy_drip_snapshots.sql"));
  await db.query(sql("20261031130200_routing_v2_skip_first_step.sql"));
  inbound=(await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body) values($1,$2,$3,'inbound','sms','Who?') returning id",[org,property,contact])).rows[0].id;
});
afterEach(()=>db.query("rollback"));
const transition=async(skip:boolean)=>(await db.query("select route_reply_transition($1,$2,$3) as r",[inbound,property,JSON.stringify({sequence_key:"asked_who",contact_id:contact,skip_first_step:skip,outbox:[{kind:"reply",payload:{key:"identity"}}]})])).rows[0].r;
describe("atomic skip-first enrollment",()=>{
  it("starts on the second step, preserving the delay and replay identity",async()=>{
    const result=await transition(true);expect(result.outcome).toBe("applied");
    expect((await db.query("select current_step_index,extract(epoch from next_run_at-now())::int as seconds from sequence_enrollments where id=$1",[result.new_enrollment_id])).rows[0]).toEqual({current_step_index:1,seconds:86400});
    expect(await transition(false)).toMatchObject({replayed:true,new_enrollment_id:result.new_enrollment_id});
    expect((await db.query("select count(*)::int as n from routing_v2_outbox where inbound_message_id=$1",[inbound])).rows[0].n).toBe(1);
  });
  it("keeps step zero when no skip is requested",async()=>{
    const result=await transition(false);
    expect((await db.query("select current_step_index from sequence_enrollments where id=$1",[result.new_enrollment_id])).rows[0].current_step_index).toBe(0);
  });
  it("refuses enrollment when the requested second step is missing, retaining the reply intent",async()=>{
    await db.query("delete from sequence_steps where sequence_id in(select id from sequences where org_id=$1 and routing_v2_key='asked_who') and step_index=1",[org]);
    expect(await transition(true)).toMatchObject({outcome:"no_sequence",new_enrollment_id:null});
    expect((await db.query("select count(*)::int as n from routing_v2_outbox where inbound_message_id=$1",[inbound])).rows[0].n).toBe(1);
  });
  it("conditional call-me stop reads the current flag and leaves legacy drips alone while off",async()=>{
    const legacy=(await db.query("insert into sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,current_step_index,next_run_at) values($1,$2,$3,$4,'active',0,now()) returning id",[org,sequence,property,contact])).rows[0].id;
    const plan={sequence_key:null,stop_drip_when_time_only_on:true,outbox:[{kind:"alert",payload:{reason:"call_me"}}]};
    const run=async()=> (await db.query("select route_reply_transition($1,$2,$3) as r",[inbound,property,JSON.stringify(plan)])).rows[0].r;
    expect((await run()).outcome).toBe("replies_only");
    expect((await db.query("select status from sequence_enrollments where id=$1",[legacy])).rows[0].status).toBe("active");
    await db.query("update ai_responder_configs set routing_v2_flags=routing_v2_flags || '{\"alert_on_time_only\":true}'::jsonb where org_id=$1",[org]);
    inbound=(await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,created_at) values($1,$2,$3,'inbound','sms','Call now',now()+interval '1 second') returning id",[org,property,contact])).rows[0].id;
    expect((await run()).outcome).toBe("applied");
    expect((await db.query("select status from sequence_enrollments where id=$1",[legacy])).rows[0].status).toBe("completed");
  });
  it("does not enroll or create intents with both slices off",async()=>{
    await db.query("update ai_responder_configs set routing_v2_flags='{}' where org_id=$1",[org]);
    expect(await transition(true)).toMatchObject({outcome:"flag_off",new_enrollment_id:null});
    expect((await db.query("select count(*)::int as n from routing_v2_outbox where inbound_message_id=$1",[inbound])).rows[0].n).toBe(0);
  });
});
