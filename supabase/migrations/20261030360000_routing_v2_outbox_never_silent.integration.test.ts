import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261030360000_routing_v2_outbox_never_silent.sql";
let org: string, property: string, contact: string, inbound: string;

beforeAll(() => db.connect());
afterAll(() => db.end());


/** A reply authorized `ageMinutes` ago (claimed + authorized: the consumer reached the provider step). */
async function authorized(ageMinutes: number) {
  const id = (await db.query("insert into routing_v2_outbox(org_id,property_id,inbound_message_id,transition_seq,kind,slice,payload,status,claimed_at,authorized_at,created_at) values($1,$2,$3,1,'reply','replies','{\"key\":\"identity\"}','claimed',now()-make_interval(mins=>$4),now()-make_interval(mins=>$4),now()-make_interval(mins=>$4)) returning id",
    [org, property, inbound, ageMinutes])).rows[0].id as string;
  return id;
}
const message = (key: string, status: string) =>
  db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,status,idempotency_key) values($1,$2,$3,'outbound','sms','Hi',$4,$5)", [org, property, contact, status, key]);
const state = async (id: string) => (await db.query("select status, cancel_reason, delivery_state, hold_pending from routing_v2_outbox where id=$1", [id])).rows[0];
const reconcile = async () => (await db.query("select routing_v2_reconcile_outbox(180, 30) as r")).rows[0].r;

describe("an authorized reply is never lost silently (review B1)", () => {
  beforeEach(async () => {
    await db.query("begin");
    org = randomUUID();
    await db.query("insert into organizations(id,name) values($1,'never silent test')", [org]);
    await db.query("insert into ai_responder_configs(org_id,system_prompt,routing_v2_flags) values($1,'test',$2)", [org, JSON.stringify({ questions_live: true, replies: true, canary_percent: 100 })]);
    contact = (await db.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'Test','+18165550100','mobile') returning id", [org])).rows[0].id;
    property = (await db.query("insert into properties(org_id,address,state,status,homeowner_contact_id) values($1,'1 Test St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
    for (const f of ["20261030300000_routing_v2_outbox_provider_fence.sql", "20261030330000_routing_v2_outbox_delivery.sql", M]) await db.query(sql(f));
    inbound = (await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,created_at) values($1,$2,$3,'inbound','sms','Who?',now()-interval '2 hours') returning id", [org, property, contact])).rows[0].id;
    await db.query("insert into routing_v2_reply_transitions(org_id,property_id,inbound_message_id,inbound_at,transition_seq,outcome,decision) select org_id,property_id,id,created_at,1,'applied','{}' from messages where id=$1", [inbound]);
  });
  afterEach(() => db.query("rollback"));
  it("killed after authorize, before the message row: cancelled as never submitted and held", async () => {
    const id = await authorized(10);
    expect(await reconcile()).toMatchObject({ never_submitted: 1 });
    expect(await state(id)).toEqual({ status: "cancelled", cancel_reason: "not_sent:no_message_row", delivery_state: null, hold_pending: true });
    const due = (await db.query("select * from routing_v2_outbox_holds_due(50)")).rows;
    expect(due).toEqual([{ outbox_id: id, property_id: property, reason: "not_sent:no_message_row", attempts: 1 }]);
    expect((await db.query("select routing_v2_mark_outbox_hold_written($1) as r", [id])).rows[0].r).toBe("ok");
    expect((await db.query("select routing_v2_mark_outbox_hold_written($1) as r", [id])).rows[0].r).toBeNull();
    expect((await db.query("select count(*)::int n from routing_v2_outbox_holds_due(50)")).rows[0].n).toBe(0);
  });
  it("a keyed row still pending: unknown (never retried); past the limit it leaves `claimed` and is held", async () => {
    const recent = await authorized(10);
    const stale = await authorized(45);
    await message(recent, "pending");
    await message(stale, "pending");
    expect(await reconcile()).toMatchObject({ unknown: 1, held_unknown: 1 });
    expect(await state(recent)).toMatchObject({ status: "claimed", delivery_state: "unknown", hold_pending: false });
    expect(await state(stale)).toEqual({ status: "cancelled", cancel_reason: "unknown:held_for_person", delivery_state: "unknown", hold_pending: true });
    expect((await db.query("select routing_v2_authorize_outbox_send($1) as r", [stale])).rows[0].r).toBe("not_claimed");
  });
  it("sent / failed keyed rows settle (failed is held too)", async () => {
    const a = await authorized(10), b = await authorized(10);
    await message(a, "delivered"); await message(b, "failed");
    expect(await reconcile()).toMatchObject({ sent: 1, not_sent: 1 });
    expect(await state(a)).toMatchObject({ status: "sent", hold_pending: false });
    expect(await state(b)).toMatchObject({ status: "cancelled", cancel_reason: "not_sent:provider_failed", hold_pending: true });
  });
  it("stuck rows never starve the window: 250 dead claims leave `claimed`, a newer one settles next pass", async () => {
    for (let i = 0; i < 250; i++) await authorized(120);
    const fresh = await authorized(5);
    await message(fresh, "sent");
    await reconcile();
    await reconcile();
    expect(await state(fresh)).toMatchObject({ status: "sent" });
    expect((await db.query("select count(*)::int n from routing_v2_outbox where status='claimed'")).rows[0].n).toBe(0);
  });
  it("50 holds that keep failing never block a newer one (failing rows rotate to the back)", async () => {
    const failing: string[] = [];
    for (let i = 0; i < 50; i++) {
      failing.push((await db.query("insert into routing_v2_outbox(org_id,property_id,inbound_message_id,transition_seq,kind,slice,status,cancel_reason,hold_pending,created_at) values($1,$2,$3,1,'reply','replies','cancelled','not_sent:no_message_row',true,now()-make_interval(mins=>200-$4)) returning id", [org, property, inbound, i])).rows[0].id);
    }
    const fresh = (await db.query("insert into routing_v2_outbox(org_id,property_id,inbound_message_id,transition_seq,kind,slice,status,cancel_reason,hold_pending) values($1,$2,$3,1,'reply','replies','cancelled','not_sent:provider_failed',true) returning id", [org, property, inbound])).rows[0].id;
    const first = (await db.query("select * from routing_v2_outbox_holds_due(50)")).rows.map((r) => r.outbox_id);
    expect([...first].sort()).toEqual([...failing].sort()); // the oldest 50; each of these holds then fails (never marked written)
    const second = (await db.query("select * from routing_v2_outbox_holds_due(50)")).rows;
    expect(second).toContainEqual(expect.objectContaining({ outbox_id: fresh, attempts: 1 }));
    expect((await db.query("select routing_v2_mark_outbox_hold_written($1) as r", [fresh])).rows[0].r).toBe("ok");
    const third = (await db.query("select * from routing_v2_outbox_holds_due(200)")).rows;
    expect(third.map((r) => r.outbox_id)).not.toContain(fresh);
    expect(third.every((r) => r.attempts >= 2)).toBe(true);
  });

  it("service role only; rolls back to the 330000 reconcile", async () => {
    expect((await db.query("select has_function_privilege('authenticated','routing_v2_outbox_holds_due(integer)','EXECUTE') as u")).rows[0].u).toBe(false);
    await db.query(sql("20261030360000_routing_v2_outbox_never_silent.sql", path.join(__dirname, "../rollbacks")));
    expect((await db.query("select to_regprocedure('public.routing_v2_reconcile_outbox(integer)') as f")).rows[0].f).not.toBeNull();
    expect((await db.query("select to_regproc('public.routing_v2_outbox_holds_due') as f")).rows[0].f).toBeNull();
  });
});

/**
 * A keyed message row committed while reconcile waits for the property lock (scan -> lock gap)
 * must not be judged "never submitted". Real commits on two connections; cleaned up after.
 */
describe("reconcile re-reads inside the lock (delta review)", () => {
  const admin = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
  const holder = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
  const ROLLBACKS = ["20261030360000_routing_v2_outbox_never_silent.sql", "20261030330000_routing_v2_outbox_delivery.sql", "20261030300000_routing_v2_outbox_provider_fence.sql"];
  let installed = false;
  let raceOrg = "";
  beforeAll(async () => {
    await admin.connect(); await holder.connect();
    installed = (await admin.query("select to_regproc('public.routing_v2_outbox_holds_due') is not null as i")).rows[0].i;
    if (!installed) {
      await admin.query("begin");
      for (const f of ["20261030300000_routing_v2_outbox_provider_fence.sql", "20261030330000_routing_v2_outbox_delivery.sql", M]) await admin.query(sql(f));
      await admin.query("commit");
    }
  });
  afterAll(async () => {
    if (raceOrg) {
      await admin.query("begin");
      await admin.query("set local session_replication_role = replica");
      for (const t of ["routing_v2_outbox", "routing_v2_reply_transitions", "messages", "properties", "contacts", "ai_responder_configs"]) {
        await admin.query(`delete from public.${t} where org_id = $1`, [raceOrg]);
      }
      await admin.query("delete from public.organizations where id = $1", [raceOrg]);
      await admin.query("commit");
    }
    if (!installed) {
      await admin.query("begin");
      for (const f of ROLLBACKS) await admin.query(sql(f, path.join(__dirname, "../rollbacks")));
      await admin.query("commit");
    }
    await holder.end(); await admin.end();
  });

  it("a message row that appears between the scan and the lock: settled as sent, no false never-sent hold", async () => {
    raceOrg = randomUUID();
    await admin.query("insert into organizations(id,name) values($1,'reconcile race')", [raceOrg]);
    await admin.query("insert into ai_responder_configs(org_id,system_prompt,routing_v2_flags) values($1,'t',$2)", [raceOrg, JSON.stringify({ questions_live: true, replies: true, canary_percent: 100 })]);
    const c = (await admin.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'R','+18165550199','mobile') returning id", [raceOrg])).rows[0].id;
    const p = (await admin.query("insert into properties(org_id,address,state,status,homeowner_contact_id) values($1,'9 Race St','MO','new_lead',$2) returning id", [raceOrg, c])).rows[0].id;
    const m = (await admin.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,created_at) values($1,$2,$3,'inbound','sms','Who?',now()-interval '2 hours') returning id", [raceOrg, p, c])).rows[0].id;
    await admin.query("insert into routing_v2_reply_transitions(org_id,property_id,inbound_message_id,inbound_at,transition_seq,outcome,decision) select org_id,property_id,id,created_at,1,'applied','{}' from messages where id=$1", [m]);
    const id = (await admin.query("insert into routing_v2_outbox(org_id,property_id,inbound_message_id,transition_seq,kind,slice,payload,status,claimed_at,authorized_at) values($1,$2,$3,1,'reply','replies','{}','claimed',now()-interval '10 minutes',now()-interval '10 minutes') returning id", [raceOrg, p, m])).rows[0].id;

    // The sender holds the property lock while its keyed message row is being written.
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(hashtext('routing_v2:' || $1::text))", [p]);
    const reconciling = admin.query("select public.routing_v2_reconcile_outbox(180, 30) as r");
    await new Promise((r) => setTimeout(r, 300)); // reconcile has scanned and now waits on the lock
    await holder.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,status,idempotency_key) values($1,$2,$3,'outbound','sms','Hi','sent',$4)", [raceOrg, p, c, id]);
    await holder.query("commit");
    await reconciling;
    const row = (await admin.query("select status, cancel_reason, hold_pending from routing_v2_outbox where id=$1", [id])).rows[0];
    expect(row).toEqual({ status: "sent", cancel_reason: null, hold_pending: false });
  });
});
