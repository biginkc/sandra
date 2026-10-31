import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";

/**
 * 20261030440000 (review B-1' of 251a3321672a): the wrong-number-all superseded hold goes through
 * routing_v2_write_hold as safety, so a lead held only for our own unsent reply is upgraded.
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261030440000_routing_v2_phone_action_safety_hold.sql";
const RB = path.join(__dirname, "../rollbacks");

beforeAll(() => db.connect());
afterAll(() => db.end());
afterEach(() => db.query("rollback"));

let ctx: { property: string; action: string; inbound: string };
const state = async () => (await db.query("select needs_human_attention h, hold_kind k, last_ai_escalation_reason r from properties where id = $1", [ctx.property])).rows[0];
const superseded = async () => (await db.query("select public.routing_v2_phone_action_hold_superseded($1, $2, 'superseded_after_commit') as v", [ctx.action, ctx.inbound])).rows[0].v as boolean;

beforeEach(async () => {
  await db.query("begin");
  await unwindRoutingV2After(db, "20261030440000");
  await db.query(sql(M));
  const org = randomUUID();
  await db.query("set local session_replication_role = replica");
  await db.query("insert into organizations (id, name) values ($1, 'phone action hold')", [org]);
  const contact = (await db.query("insert into contacts (org_id, first_name, last_name, phone_1) values ($1,'Pat','Phone','+18165550125') returning id", [org])).rows[0].id;
  const property = (await db.query("insert into properties (org_id, address, state, status, homeowner_contact_id) values ($1,'1 Phone St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  const inbound = (await db.query("insert into messages (org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body) values ($1,'sms','inbound','received',$2,$3,'+18165550125','+18165550199','hi') returning id", [org, property, contact])).rows[0].id;
  const action = (await db.query("insert into routing_v2_phone_actions (org_id, source_property_id, source_inbound_message_id, action, phone_e164, status, reply_state) values ($1,$2,$3,'wrong_number_all','+18165550125','applied','pending') returning id", [org, property, inbound])).rows[0].id;
  await db.query("set local session_replication_role = origin");
  ctx = { property, action, inbound };
});

describe("routing_v2_phone_action_hold_superseded through the one hold writer", () => {
  it("an unheld lead is held (safety, nine_needs_person)", async () => {
    expect(await superseded()).toBe(true);
    expect(await state()).toEqual({ h: true, k: "safety", r: "nine_needs_person" });
  });
  it("a lead held only for our own unsent reply is upgraded to safety (was left as mechanics)", async () => {
    await db.query("select public.routing_v2_write_hold($1,$2,'nine_reply_not_sent:provider_failed','mechanics')", [ctx.property, ctx.inbound]);
    expect(await superseded()).toBe(true);
    expect(await state()).toEqual({ h: true, k: "safety", r: "nine_needs_person" });
  });
  it("a safety hold is left as it is", async () => {
    await db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'legal_threat' where id = $1", [ctx.property]);
    expect(await superseded()).toBe(false);
    expect((await state()).r).toBe("legal_threat");
  });
  it("a DNC-locked lead is never written", async () => {
    await db.query("set local session_replication_role = replica");
    await db.query("update properties set is_dnc_locked = true where id = $1", [ctx.property]);
    await db.query("set local session_replication_role = origin");
    expect(await superseded()).toBe(false);
    expect((await state()).h).toBe(false);
  });
});

describe("rollback", () => {
  it("restores the 250000 body: a mechanics-held lead is left as it was", async () => {
    await db.query(sql(M, RB));
    await db.query("select public.routing_v2_write_hold($1,$2,'nine_reply_not_sent:provider_failed','mechanics')", [ctx.property, ctx.inbound]);
    expect(await superseded()).toBe(false);
    expect((await state()).k).toBe("mechanics");
  });
});
