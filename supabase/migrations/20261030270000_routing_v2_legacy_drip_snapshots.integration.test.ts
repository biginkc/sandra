import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const migration = readFileSync(path.join(__dirname, "20261030270000_routing_v2_legacy_drip_snapshots.sql"), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const rollback = readFileSync(path.join(__dirname, "../rollbacks/20261030270000_routing_v2_legacy_drip_snapshots.sql"), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
let org: string;
beforeAll(() => db.connect());
afterAll(() => db.end());
beforeEach(async () => {
  await db.query("begin"); org = randomUUID();
  // A-7: on a fully migrated / shared stack, other orgs' v2 drips (used or versioned) would trip
  // the rollback's stack-wide guard. Clear them inside this rolled-back transaction only.
  await unwindRoutingV2After(db, "20261030270000");
  await db.query("select set_config('routing_v2.allow_drip_edit','on',true)");
  await db.query("delete from sequence_enrollments where sequence_id in (select id from sequences where routing_v2_key is not null)");
  await db.query("delete from sequence_steps where sequence_id in (select id from sequences where routing_v2_key is not null)");
  await db.query("delete from sequences where routing_v2_key is not null");
  await db.query("select set_config('routing_v2.allow_drip_edit','',true)");
  await db.query("insert into organizations(id,name) values($1,'routing snapshot test')", [org]);
  await db.query("insert into ai_responder_configs(org_id,system_prompt) values($1,'test')", [org]);
});
afterEach(() => db.query("rollback"));
async function source(name = "Maybe later") {
  const id = (await db.query("insert into sequences(org_id,name,active,append_opt_out) values($1,$2,true,true) returning id", [org,name])).rows[0].id;
  await db.query("insert into sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values($1,0,0,'send_sms','Hello'),($1,1,1440,'send_sms','Later')", [id]);
  return id;
}
async function snapshots() { return (await db.query("select * from sequences where org_id=$1 and routing_v2_key is not null order by routing_v2_key", [org])).rows; }
describe("unchanged legacy roads become immutable v2 snapshots", () => {
  it("copies all four roads with exact text, delays, footer and no chaining, leaving sources intact", async () => {
    const sources: string[] = [];
    for (const name of ["Maybe later","Not interested","Asked who is texting","Confirmed owner"]) sources.push(await source(name));
    await db.query(migration);
    const rows = await snapshots();
    expect(rows.map(r => r.routing_v2_key)).toEqual(["asked_who","confirmed_owner","maybe_later","not_interested"]);
    for (const row of rows) {
      expect(row).toMatchObject({ active:false, append_opt_out:true, routing_v2_version:1, routing_v2_then_key:null });
      expect((await db.query("select step_index,delay_after_previous_minutes,template_body,template_id,template_category from sequence_steps where sequence_id=$1 order by step_index", [row.id])).rows).toEqual([
        { step_index:0,delay_after_previous_minutes:0,template_body:"Hello",template_id:null,template_category:null },
        { step_index:1,delay_after_previous_minutes:1440,template_body:"Later",template_id:null,template_category:null },
      ]);
    }
    expect((await db.query("select count(*)::int as n from sequences where id=any($1) and active and routing_v2_key is null", [sources])).rows[0].n).toBe(4);
    await db.query(migration); expect(await snapshots()).toHaveLength(4);
  });
  it("refuses gapped and empty sources without manufacturing a drip", async () => {
    const gap=await source("Not interested");
    await db.query("delete from sequence_steps where sequence_id=$1 and step_index=0",[gap]);
    const empty=await source("Asked who is texting");
    await db.query("delete from sequence_steps where sequence_id=$1",[empty]);
    await db.query(migration); expect(await snapshots()).toEqual([]);
  });
  it("refuses pools and non-SMS actions instead of changing approved content", async () => {
    const pool=await source();
    await db.query("update sequence_steps set template_body=null,template_category='nurture' where sequence_id=$1",[pool]);
    const nonSms=await source("Not interested");
    await db.query("update sequence_steps set action_type='change_status',target_status='nurture' where sequence_id=$1",[nonSms]);
    await db.query(migration); expect(await snapshots()).toEqual([]);
  });
  it("rolls back unused snapshots without touching sources", async () => {
    const id=await source(); await db.query(migration); await db.query(rollback);
    expect(await snapshots()).toEqual([]);
    expect((await db.query("select active,routing_v2_key from sequences where id=$1",[id])).rows[0]).toEqual({active:true,routing_v2_key:null});
  });
  it("refuses rollback after a later snapshot version exists", async () => {
    await source(); await db.query(migration);
    await db.query("update sequences set routing_v2_version=2 where org_id=$1 and routing_v2_key='maybe_later'",[org]);
    await expect(db.query(rollback)).rejects.toThrow("used or superseded");
  });
  it("locks snapshots after the migration opt-in ends", async () => {
    await source(); await db.query(migration); const row=(await snapshots())[0];
    await db.query("select set_config('routing_v2.allow_drip_edit','',true)");
    await expect(db.query("update sequences set active=true where id=$1",[row.id])).rejects.toThrow("ROUTING_V2_DRIP_LOCKED");
  });
});
