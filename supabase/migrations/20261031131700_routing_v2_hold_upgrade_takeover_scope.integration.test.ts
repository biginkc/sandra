import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";

/**
 * 20261031131700 (review of 3288da8ef6b3): B-1 a hold re-asserted on a lead held only for our own
 * unsent reply upgrades the label to safety (never downgrades); N-6 the takeover stamp takes one
 * property (one routing lock) per call. Each test is rolled back.
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261031131700_routing_v2_hold_upgrade_takeover_scope.sql";
const RB = path.join(__dirname, "../rollbacks");

beforeAll(() => db.connect());
afterAll(() => db.end());
afterEach(() => db.query("rollback"));

let ctx: { org: string; property: string; inbound: string };
const kind = async () => (await db.query("select needs_human_attention h, hold_kind k, last_ai_escalation_reason r from properties where id = $1", [ctx.property])).rows[0];

beforeEach(async () => {
  await db.query("begin");
  await unwindRoutingV2After(db, "20261031131700");
  await db.query(sql(M));
  const org = randomUUID();
  await db.query("set local session_replication_role = replica");
  await db.query("insert into organizations (id, name) values ($1, 'hold upgrade')", [org]);
  const contact = (await db.query("insert into contacts (org_id, first_name, last_name, phone_1) values ($1,'Pat','Up','+18165550124') returning id", [org])).rows[0].id;
  const property = (await db.query("insert into properties (org_id, address, state, status, homeowner_contact_id) values ($1,'1 Up St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  const inbound = (await db.query("insert into messages (org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body) values ($1,'sms','inbound','received',$2,$3,'+18165550124','+18165550199','hi') returning id", [org, property, contact])).rows[0].id;
  await db.query("set local session_replication_role = origin");
  ctx = { org, property, inbound };
  expect((await db.query("select public.routing_v2_write_hold($1,$2,'nine_reply_not_sent:provider_failed','mechanics') as r", [property, inbound])).rows[0].r).toBe("held");
});

describe("B-1: a hold on a lead held only for our own unsent reply becomes safety", () => {
  it("a plain SQL / UI / keyword writer that sets the reason upgrades it", async () => {
    await db.query("update properties set last_ai_escalation_reason = 'legal_threat' where id = $1", [ctx.property]);
    expect(await kind()).toEqual({ h: true, k: "safety", r: "legal_threat" });
  });
  it("re-setting the flag upgrades it", async () => {
    await db.query("update properties set needs_human_attention = true where id = $1", [ctx.property]);
    expect((await kind()).k).toBe("safety");
  });
  it("routing_v2_write_hold safety upgrades (with its reason); a newer text can then no longer clear it", async () => {
    expect((await db.query("select public.routing_v2_write_hold($1,null,'nine_asked_stop','safety') as r", [ctx.property])).rows[0].r).toBe("upgraded");
    expect(await kind()).toEqual({ h: true, k: "safety", r: "nine_asked_stop" });
  });
  it("never downgrades, and a mechanics re-write onto a held lead changes nothing", async () => {
    expect((await db.query("select public.routing_v2_write_hold($1,$2,'nine_reply_not_sent:x','mechanics') as r", [ctx.property, ctx.inbound])).rows[0].r).toBe("already_held");
    expect((await kind()).k).toBe("mechanics");
    await db.query("update properties set last_ai_escalation_reason = 'needs_reply' where id = $1", [ctx.property]);
    await db.query("update properties set hold_kind = 'mechanics', last_ai_escalation_reason = 'x' where id = $1", [ctx.property]);
    expect((await kind()).k).toBe("safety");
  });
  it("clearing the hold is not an upgrade (the kind is cleared)", async () => {
    await db.query("update properties set needs_human_attention = false where id = $1", [ctx.property]);
    expect(await kind()).toMatchObject({ h: false, k: null });
  });
});

describe("N-6: one property per takeover stamp", () => {
  it("routing_v2_mark_person_takeover(uuid) stamps the DB clock; the multi-property form is gone", async () => {
    expect((await db.query("select public.routing_v2_mark_person_takeover($1::uuid) as r", [ctx.property])).rows[0].r).toBe(true);
    expect((await db.query("select last_person_takeover_at is not null as s from properties where id = $1", [ctx.property])).rows[0].s).toBe(true);
    expect((await db.query("select to_regprocedure('public.routing_v2_mark_person_takeover(uuid[])') is null as gone")).rows[0].gone).toBe(true);
  });
});

describe("rollback", () => {
  it("restores 320000 record_live_hold and the 420000 takeover form; a re-asserted hold no longer upgrades", async () => {
    await db.query(sql(M, RB));
    expect((await db.query("select to_regprocedure('public.routing_v2_mark_person_takeover(uuid[])') is not null as back")).rows[0].back).toBe(true);
    expect((await db.query("select pg_get_functiondef('public.routing_v2_record_live_hold(uuid,uuid,jsonb)'::regprocedure) like '%routing_v2_write_hold%' as up")).rows[0].up).toBe(false);
    await db.query("update properties set last_ai_escalation_reason = 'legal_threat' where id = $1", [ctx.property]);
    expect((await kind()).k).toBe("mechanics");
  });
});
