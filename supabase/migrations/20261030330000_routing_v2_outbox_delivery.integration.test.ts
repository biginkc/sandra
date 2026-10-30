import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261030330000_routing_v2_outbox_delivery.sql";
let org: string, property: string, contact: string, inbound: string;
const FLAGS = { questions_live: true, replies: true, drips: true, canary_percent: 100 };

beforeAll(() => db.connect());
afterAll(() => db.end());
beforeEach(async () => {
  await db.query("begin");
  org = randomUUID();
  await db.query("insert into organizations(id,name) values($1,'outbox delivery test')", [org]);
  await db.query("insert into ai_responder_configs(org_id,system_prompt,routing_v2_flags) values($1,'test',$2)", [org, JSON.stringify(FLAGS)]);
  contact = (await db.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'Test','+18165550100','mobile') returning id", [org])).rows[0].id;
  property = (await db.query("insert into properties(org_id,address,state,status,homeowner_contact_id) values($1,'1 Test St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  for (const f of ["20261030300000_routing_v2_outbox_provider_fence.sql", M]) await db.query(sql(f));
  inbound = (await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,created_at) values($1,$2,$3,'inbound','sms','Who?',now()-interval '1 minute') returning id", [org, property, contact])).rows[0].id;
  await db.query("insert into routing_v2_reply_transitions(org_id,property_id,inbound_message_id,inbound_at,transition_seq,outcome,decision) select org_id,property_id,id,created_at,1,'applied','{}' from messages where id=$1", [inbound]);
});
afterEach(() => db.query("rollback"));

async function row(kind: "reply" | "alert", payload: Record<string, unknown> = {}) {
  return (await db.query("insert into routing_v2_outbox(org_id,property_id,inbound_message_id,transition_seq,kind,slice,payload) values($1,$2,$3,1,$4,'replies',$5) returning id",
    [org, property, inbound, kind, JSON.stringify(payload)])).rows[0].id as string;
}
const call = async (fn: string, ...args: unknown[]) =>
  (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) as r`, args)).rows[0].r;
const state = async (id: string) => (await db.query("select status, cancel_reason, provider_receipt, delivery_state from routing_v2_outbox where id=$1", [id])).rows[0];

describe("routing v2 outbox delivery", () => {
  it("claim -> authorize -> provider check -> sent, at most once, receipt bound", async () => {
    const id = await row("reply", { key: "identity" });
    expect(await call("routing_v2_mark_outbox_sent", id, "msg-1")).toBe("not_authorized");
    expect(await call("routing_v2_claim_outbox", id)).toBe("ok");
    expect(await call("routing_v2_authorize_outbox_send", id)).toBe("ok");
    expect(await call("routing_v2_authorize_outbox_send", id)).toBe("already_authorized");
    expect(await call("routing_v2_check_authorized_outbox_send", id, property, inbound)).toBe("ok");
    expect(await call("routing_v2_mark_outbox_sent", id, "")).toBe("missing_receipt");
    expect(await call("routing_v2_mark_outbox_sent", id, "msg-1")).toBe("ok");
    expect(await call("routing_v2_mark_outbox_sent", id, "msg-1")).toBe("ok");
    expect(await call("routing_v2_mark_outbox_sent", id, "msg-2")).toBe("receipt_mismatch");
    expect(await call("routing_v2_claim_outbox", id)).toBe("not_pending");
    expect(await state(id)).toMatchObject({ status: "sent", provider_receipt: "msg-1" });
  });

  it("an unknown provider outcome is never retried or downgraded by a caller", async () => {
    const id = await row("reply", { key: "identity" });
    await call("routing_v2_claim_outbox", id); await call("routing_v2_authorize_outbox_send", id);
    expect(await call("routing_v2_mark_outbox_unknown", id, "provider_outcome_unknown")).toBe("ok");
    expect(await call("routing_v2_mark_outbox_not_sent", id, "x")).toBe("unknown");
    expect(await call("routing_v2_authorize_outbox_send", id)).toBe("already_authorized");
    expect(await call("routing_v2_release_stale_outbox_claims", 60)).toBe(0);
    expect(await state(id)).toMatchObject({ status: "claimed", delivery_state: "unknown" });
  });

  it("a never-authorized stale claim returns to pending; an authorized one never does", async () => {
    const a = await row("reply", { key: "identity" });
    const b = await row("reply", { key: "identity" });
    await call("routing_v2_claim_outbox", a); await call("routing_v2_claim_outbox", b); await call("routing_v2_authorize_outbox_send", b);
    await db.query("update routing_v2_outbox set claimed_at=now()-interval '10 minutes' where id in ($1,$2)", [a, b]);
    expect(await call("routing_v2_release_stale_outbox_claims", 300)).toBe(1);
    expect((await state(a)).status).toBe("pending");
    expect((await state(b)).status).toBe("claimed");
  });

  it("reconcile settles from the durable message keyed by the outbox id", async () => {
    const ids = [await row("reply", { key: "identity" }), await row("reply", { key: "identity" }), await row("reply", { key: "identity" })];
    for (const id of ids) { await call("routing_v2_claim_outbox", id); await call("routing_v2_authorize_outbox_send", id); }
    await db.query("update routing_v2_outbox set authorized_at=now()-interval '10 minutes' where id = any($1)", [ids]);
    for (const [id, status] of [[ids[0], "sent"], [ids[1], "failed"]] as const) {
      await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,status,idempotency_key) values($1,$2,$3,'outbound','sms','Hi',$4,$5)", [org, property, contact, status, id]);
    }
    expect(await call("routing_v2_reconcile_outbox", 60)).toEqual({ sent: 1, not_sent: 1, unknown: 1 });
    expect((await state(ids[0])).status).toBe("sent");
    expect(await state(ids[1])).toMatchObject({ status: "cancelled", cancel_reason: "not_sent:provider_failed" });
    expect(await state(ids[2])).toMatchObject({ status: "claimed", delivery_state: "unknown" });
  });

  it("not-sent before the provider cancels with the reason; due list shows only pending replies", async () => {
    const r = await row("reply", { key: "identity" }); await row("alert", { reason: "call_me" });
    expect((await db.query("select id from routing_v2_due_outbox_replies(20,$1)", [property])).rows.map((x) => x.id)).toEqual([r]);
    expect(await call("routing_v2_mark_outbox_not_sent", r, "template_already_sent")).toBe("ok");
    expect(await state(r)).toMatchObject({ status: "cancelled", cancel_reason: "not_sent:template_already_sent" });
  });

  it("owner alert gate: claim+authorize+provider check once, then flags-only re-checks (N2)", async () => {
    const id = await row("alert", { reason: "call_me", dedupe_key: "hot_text:x" });
    expect(await call("routing_v2_alert_delivery_gate", id, "hot_text:x")).toBe("ok");
    expect(await state(id)).toMatchObject({ status: "sent", provider_receipt: "hot_text:x" });
    expect(await call("routing_v2_alert_delivery_gate", id, "hot_text:x")).toBe("ok");
    await db.query("update ai_responder_configs set routing_v2_flags=$2 where org_id=$1", [org, JSON.stringify({ ...FLAGS, replies: false })]);
    expect(await call("routing_v2_alert_delivery_gate", id, "hot_text:x")).toBe("flag_off");
  });

  it("an owner alert survives a newer seller reply; a stale yes alert is refused once time-only is on", async () => {
    const callMe = await row("alert", { reason: "call_me" });
    const yes = await row("alert", { reason: "hot_yes", when_time_only_off: true });
    await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body) values($1,$2,$3,'inbound','sms','Thanks')", [org, property, contact]);
    expect(await call("routing_v2_alert_delivery_gate", callMe, "k1")).toBe("ok");
    await db.query("update ai_responder_configs set routing_v2_flags=$2 where org_id=$1", [org, JSON.stringify({ ...FLAGS, alert_on_time_only: true })]);
    expect(await call("routing_v2_alert_delivery_gate", yes, "k2")).toBe("time_only_alert_disabled");
    expect((await state(yes)).status).toBe("cancelled");
  });

  it("service role only, idempotent, rolls back while no delivery evidence exists", async () => {
    await db.query(sql(M));
    expect((await db.query("select has_function_privilege('authenticated','routing_v2_mark_outbox_sent(uuid,text)','EXECUTE') as u, has_function_privilege('service_role','routing_v2_alert_delivery_gate(uuid,text)','EXECUTE') as s")).rows[0]).toEqual({ u: false, s: true });
    await db.query(sql("20261030330000_routing_v2_outbox_delivery.sql", path.join(__dirname, "../rollbacks")));
    expect((await db.query("select to_regproc('public.routing_v2_mark_outbox_sent') as f")).rows[0].f).toBeNull();
  });
});
