import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";

/**
 * 20261030450000 (Astra review of 921b71c2a133, P1): the final provider fence refuses an automatic
 * reply to a held lead (held_for_person); owner alerts still pass. Each test is rolled back.
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261030450000_routing_v2_fence_held_lead.sql";
const RB = path.join(__dirname, "../rollbacks");

beforeAll(() => db.connect());
afterAll(() => db.end());
afterEach(() => db.query("rollback"));

let ctx: { org: string; property: string; inbound: string };
const row = async (kind: "reply" | "alert") => (await db.query(
  "insert into routing_v2_outbox (org_id, property_id, inbound_message_id, transition_seq, kind, engine, slice, status, claimed_at, authorized_at) values ($1,$2,$3,1,$4,'v2',$5,'claimed',now(),now()) returning id",
  [ctx.org, ctx.property, ctx.inbound, kind, "replies"])).rows[0].id as string;
const fence = async (id: string) => (await db.query("select public.routing_v2_check_authorized_outbox_send($1,$2,$3) as r", [id, ctx.property, ctx.inbound])).rows[0].r as string;

beforeEach(async () => {
  await db.query("begin");
  await unwindRoutingV2After(db, "20261030450000");
  await db.query(sql(M));
  const org = randomUUID();
  await db.query("set local session_replication_role = replica");
  await db.query("insert into organizations (id, name) values ($1, 'fence held')", [org]);
  const contact = (await db.query("insert into contacts (org_id, first_name, last_name, phone_1) values ($1,'Pat','Fence','+18165550126') returning id", [org])).rows[0].id;
  const property = (await db.query("insert into properties (org_id, address, state, status, homeowner_contact_id, is_dnc_locked) values ($1,'1 Fence St','MO','new_lead',$2,false) returning id", [org, contact])).rows[0].id;
  const inbound = (await db.query("insert into messages (org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body, created_at) values ($1,'sms','inbound','received',$2,$3,'+18165550126','+18165550199','hi', now() - interval '1 minute') returning id", [org, property, contact])).rows[0].id;
  await db.query("insert into ai_responder_configs (org_id, system_prompt, routing_v2_flags) values ($1,'x',$2::jsonb)", [org, JSON.stringify({ questions_live: true, replies: true, drips: true, canary_percent: 100 })]);
  await db.query("insert into routing_v2_reply_transitions (org_id, property_id, inbound_message_id, inbound_at, transition_seq, outcome, decision) values ($1,$2,$3, now() - interval '1 minute', 1, 'applied', '{}'::jsonb)", [org, property, inbound]);
  await db.query("set local session_replication_role = origin");
  ctx = { org, property, inbound };
});

describe("routing_v2_check_authorized_outbox_send: a held lead", () => {
  it("an unheld lead passes (control)", async () => {
    expect(await fence(await row("reply"))).toBe("ok");
  });
  it("a held lead: the reply is refused and cancelled held_for_person", async () => {
    const id = await row("reply");
    await db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'nine_asked_stop' where id = $1", [ctx.property]);
    expect(await fence(id)).toBe("held_for_person");
    expect((await db.query("select status, cancel_reason from routing_v2_outbox where id = $1", [id])).rows[0]).toEqual({ status: "cancelled", cancel_reason: "held_for_person" });
  });
  it("a held lead: an owner alert still passes", async () => {
    const id = await row("alert");
    await db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'nine_asked_stop' where id = $1", [ctx.property]);
    expect(await fence(id)).toBe("ok");
  });
});

describe("rollback", () => {
  it("restores the 300000 body: a held lead's reply passes the fence again", async () => {
    await db.query(sql(M, RB));
    const id = await row("reply");
    await db.query("update properties set needs_human_attention = true where id = $1", [ctx.property]);
    expect(await fence(id)).toBe("ok");
  });
});
