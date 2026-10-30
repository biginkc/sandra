import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { APPROVED_REPLY_TEXTS } from "@/lib/ai-responder/approved-reply-texts";
import { isV2Eligible, parseRoutingV2Flags } from "@/lib/sms-classification/routing-v2/flags";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * 20261030150000: routing v2 PR-G phone-level actions (wrong_number_all, bad_number).
 * Local-only; one rolled-back transaction per test.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261030150000_routing_v2_wrong_number_all.sql"), "utf8"));
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "..", "rollbacks", "20261030150000_routing_v2_wrong_number_all.sql"), "utf8"),
);

const X = "+18165550101"; // the phone that texted "wrong number"
const Y = "+18165550202"; // a different person's phone
const Z = "+18165550303"; // a second phone on a contact that also holds X

const db = new Client({ connectionString: url });
let orgId: string;
let ownerId: string;
let outsiderId: string;
const ids: Record<string, string> = {};
let inbound: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function setFlags(flags: Record<string, unknown>) {
  await db.query(`update public.ai_responder_configs set routing_v2_flags = routing_v2_flags || $2::jsonb where org_id = $1`, [
    orgId,
    JSON.stringify(flags),
  ]);
}

const ON = { questions_live: true, wrong_number_all: true, canary_percent: 100 };

beforeEach(async () => {
  await db.query("begin");
  await db.query(MIGRATION);
  orgId = randomUUID();
  ownerId = randomUUID();
  outsiderId = randomUUID();
  for (const k of ["c1", "c2", "c3", "p1", "p2", "p3", "p4", "p5", "conv"]) ids[k] = randomUUID();
  inbound = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, 'prg')", [orgId]);
  await db.query("set local session_replication_role = replica");
  for (const id of [ownerId, outsiderId]) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `u-${id}@test.local`]);
  }
  await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`, [orgId, ownerId]);
  await db.query(`insert into public.ai_responder_configs (org_id, system_prompt, active) values ($1, 'x', true)`, [orgId]);
  // c1 holds only X; c2 holds only Y; c3 holds X and Z.
  await db.query(`insert into public.contacts (id, org_id, phone_1) values ($1, $2, $3)`, [ids.c1, orgId, X]);
  await db.query(`insert into public.contacts (id, org_id, phone_1) values ($1, $2, $3)`, [ids.c2, orgId, Y]);
  await db.query(`insert into public.contacts (id, org_id, phone_1, phone_2) values ($1, $2, $3, $4)`, [ids.c3, orgId, Z, X]);
  const prop = (id: string, contact: string, dispo: string | null, extra = "") =>
    db.query(
      `insert into public.properties (id, org_id, address, state, status, homeowner_contact_id, outreach_dispo${extra ? ", follow_up_at, last_ai_escalation_reason" : ""})
       values ($1, $2, 'St', 'MO', 'prospect', $3, $4${extra ? ", '2026-11-05T15:00:00Z', 'old_reason'" : ""})`,
      [id, orgId, contact, dispo],
    );
  await prop(ids.p1, ids.c1, null); // source
  await prop(ids.p2, ids.c1, "not_interested", "with-follow-up");
  await prop(ids.p3, ids.c1, "needs_sequence");
  await prop(ids.p4, ids.c2, null); // other phone: never a target
  await prop(ids.p5, ids.c3, null); // X plus another phone: skipped
  await db.query(
    `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body, from_address, created_at)
     values ($1, $2, $3, $4, 'sms', 'inbound', 'wrong number', $5, now() - interval '1 minute')`,
    [inbound, orgId, ids.p1, ids.conv, X],
  );
  await db.query("set local session_replication_role = origin");
});
afterEach(async () => {
  await db.query("rollback");
});

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint svc");
  await db.query("set local role service_role");
  await db.query("select set_config('request.jwt.claim.role', 'service_role', true)");
  try {
    const out = await fn();
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claim.role', '', true)");
    await db.query("release savepoint svc");
    return out;
  } catch (e) {
    await db.query("rollback to savepoint svc");
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claim.role', '', true)");
    throw e;
  }
}

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint usr");
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  try {
    const out = await fn();
    await db.query("reset role");
    await db.query("release savepoint usr");
    return out;
  } catch (e) {
    await db.query("rollback to savepoint usr");
    await db.query("reset role");
    throw e;
  }
}

const claim = (action = "wrong_number_all", msg = inbound, phone = X, leaseSeconds = 120) =>
  asService(async () =>
    (await db.query(`select public.fn_routing_v2_phone_action_claim($1, $2, $3, '{}'::jsonb, $4) as r`, [msg, action, phone, leaseSeconds])).rows[0].r,
  );
const step = (actionId: string, name: string, reply: string | null = null, reason: string | null = null) =>
  asService(async () => (await db.query(`select public.fn_routing_v2_phone_action_step($1, $2, $3, $4) as r`, [actionId, name, reply, reason])).rows[0].r);
const applyOnly = (actionId: string) =>
  asService(async () => (await db.query(`select public.fn_routing_v2_phone_action_apply($1) as r`, [actionId])).rows[0].r);
/** wrong_number_all: begin_send + sent(reply) first (the durable send record), then apply. */
const apply = async (actionId: string, reply: string | null = null) => {
  if (reply) {
    await step(actionId, "begin_send");
    await step(actionId, "sent", reply);
  }
  return applyOnly(actionId);
};
const takeLease = (actionId: string) =>
  asService(async () => (await db.query(`select public.fn_routing_v2_phone_action_take_lease($1, $2) as r`, [actionId, APPROVED_REPLY_TEXTS.wrong_number])).rows[0].r);
const expireLease = (actionId: string) =>
  db.query(`update public.routing_v2_phone_actions set lease_expires_at = now() - interval '1 second' where id = $1`, [actionId]);
const undo = (userId: string, actionId: string) =>
  asUser(userId, async () => (await db.query(`select public.fn_undo_routing_v2_phone_action($1) as r`, [actionId])).rows[0].r);

const snapshot = async () =>
  (
    await db.query(
      `select id, outreach_dispo, follow_up_at, needs_human_attention, last_ai_escalation_reason from public.properties where org_id = $1 order by id`,
      [orgId],
    )
  ).rows;
const contacts = async () =>
  (await db.query(`select id, phone_1, phone_2, phone_3, sms_opted_out, do_not_contact from public.contacts where org_id = $1 order by id`, [orgId])).rows;
const dispo = async (id: string) =>
  (await db.query(`select outreach_dispo from public.properties where id = $1`, [id])).rows[0].outreach_dispo;
const count = async (table: string) => Number((await db.query(`select count(*) from public.${table} where org_id = $1`, [orgId])).rows[0].count);

describe("routing v2 PR-G phone actions", () => {
  it("flag off (default): not applicable, writes nothing, changes nothing", async () => {
    const before = await snapshot();
    expect(await claim()).toEqual({ status: "not_applicable", reason: "flag_off" });
    await setFlags({ wrong_number_all: true }); // questions_live still false
    expect(await claim()).toEqual({ status: "not_applicable", reason: "flag_off" });
    await setFlags({ questions_live: true, wrong_number_all: false, canary_percent: 100 });
    expect(await claim()).toEqual({ status: "not_applicable", reason: "flag_off" });
    expect(await count("routing_v2_phone_actions")).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("marks every property for the phone wrong_number; other phones, other contacts and mixed-phone properties untouched", async () => {
    await setFlags(ON);
    const contactsBefore = await contacts();
    const c = await claim();
    expect(c.status).toBe("claimed");
    expect(await dispo(ids.p1)).toBeNull(); // nothing applied before the reply
    const r = await apply(c.actionId, randomUUID());
    expect(r.status).toBe("applied");
    expect([...r.applied].sort()).toEqual([ids.p1, ids.p2, ids.p3].sort());
    expect(r.skipped).toEqual([{ propertyId: ids.p5, reason: "other_phones_on_contact" }]);
    expect(await dispo(ids.p1)).toBe("wrong_number");
    expect(await dispo(ids.p2)).toBe("wrong_number");
    expect(await dispo(ids.p3)).toBe("wrong_number");
    expect(await dispo(ids.p4)).toBeNull();
    expect(await dispo(ids.p5)).toBeNull();
    expect(await contacts()).toEqual(contactsBefore);
    expect(await count("sms_phone_suppressions")).toBe(0);
    const audit = (await db.query(`select property_id, outcome, skip_reason from public.routing_v2_phone_action_properties where action_id = $1`, [c.actionId])).rows;
    expect(audit).toHaveLength(4);
    const events = (await db.query(`select payload from public.lead_events where org_id = $1 and event_type = 'dispo_set'`, [orgId])).rows;
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.payload.auto_accepted === true && e.payload.to === "wrong_number")).toBe(true);
    // No pending human review is created (auto-accepted).
    expect(Number((await db.query(`select count(*) from public.ai_disposition_reviews where org_id = $1`, [orgId])).rows[0].count)).toBe(0);
  });

  it("is idempotent under duplicate webhooks: second claim and second apply are replays", async () => {
    await setFlags(ON);
    const c = await claim();
    expect(await claim()).toMatchObject({ status: "replayed", actionId: c.actionId, actionStatus: "claimed" });
    await apply(c.actionId, randomUUID());
    expect(await claim()).toMatchObject({ status: "replayed", actionStatus: "applied" });
    expect(await apply(c.actionId, randomUUID())).toMatchObject({ status: "replayed", actionStatus: "applied" });
    expect(await count("routing_v2_phone_actions")).toBe(1);
    expect(await count("routing_v2_phone_action_properties")).toBe(4);
  });

  it("undo restores every property exactly, and is idempotent", async () => {
    await setFlags(ON);
    const before = await snapshot();
    const c = await claim();
    await apply(c.actionId, randomUUID());
    await db.query(`update public.routing_v2_phone_action_properties set paused_enrollment_ids = $2 where action_id = $1 and property_id = $3`, [
      c.actionId,
      [ids.c1],
      ids.p2,
    ]);
    const u = await undo(ownerId, c.actionId);
    expect(u.status).toBe("undone");
    expect([...u.restored].sort()).toEqual([ids.p1, ids.p2, ids.p3].sort());
    expect(u.enrollmentIds).toEqual([ids.c1]);
    expect(await snapshot()).toEqual(before);
    expect(await undo(ownerId, c.actionId)).toMatchObject({ status: "already_undone", restored: [] });
    expect(await snapshot()).toEqual(before);
  });

  it("undo never overwrites a property a person changed since; the rest are restored", async () => {
    await setFlags(ON);
    const c = await claim();
    await apply(c.actionId, randomUUID());
    await db.query(`update public.properties set outreach_dispo = 'callback_requested' where id = $1`, [ids.p3]);
    const u = await undo(ownerId, c.actionId);
    expect(u.status).toBe("partial");
    expect(u.stateChanged).toEqual([ids.p3]);
    expect(await dispo(ids.p3)).toBe("callback_requested");
    expect(await dispo(ids.p2)).toBe("not_interested");
  });

  it("undo never erases a hold raised after the action (audited skip)", async () => {
    await setFlags(ON);
    const c = await claim();
    await apply(c.actionId, randomUUID());
    await db.query(`update public.properties set needs_human_attention = true, last_ai_escalation_reason = 'person_needs_to_look' where id = $1`, [ids.p2]);
    const u = await undo(ownerId, c.actionId);
    expect(u.status).toBe("partial");
    expect(u.skipped).toEqual([{ propertyId: ids.p2, reason: "hold_changed" }]);
    const p2 = (await db.query(`select outreach_dispo, needs_human_attention, last_ai_escalation_reason from public.properties where id = $1`, [ids.p2])).rows[0];
    expect(p2).toEqual({ outreach_dispo: "wrong_number", needs_human_attention: true, last_ai_escalation_reason: "person_needs_to_look" });
    const audit = (await db.query(`select payload from public.lead_events where property_id = $1 and event_type = 'routing_v2_phone_action_undo_skipped'`, [ids.p2])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].payload.reason).toBe("hold_changed");
    // A reason alone (no flag) also counts as a later hold.
    await db.query(`update public.properties set needs_human_attention = false, last_ai_escalation_reason = 'x' where id = $1`, [ids.p2]);
    expect((await undo(ownerId, c.actionId)).skipped).toEqual([{ propertyId: ids.p2, reason: "hold_changed" }]);
  });

  it("undo with the phone suppressed now restores nothing and resumes no drips (audited)", async () => {
    await setFlags(ON);
    const c = await claim();
    await apply(c.actionId, randomUUID());
    await db.query(`update public.routing_v2_phone_action_properties set paused_enrollment_ids = $2 where action_id = $1`, [c.actionId, [randomUUID()]]);
    await db.query(`insert into public.sms_phone_suppressions (org_id, phone_e164, source) values ($1, $2, 'stop')`, [orgId, X]);
    const u = await undo(ownerId, c.actionId);
    expect(u.status).toBe("partial");
    expect(u.restored).toEqual([]);
    expect(u.enrollmentIds).toEqual([]);
    expect(u.skipped).toHaveLength(3);
    expect(u.skipped.every((s: { reason: string }) => s.reason === "phone_suppressed")).toBe(true);
    for (const id of [ids.p1, ids.p2, ids.p3]) expect(await dispo(id)).toBe("wrong_number");
    expect(await count("sms_phone_suppressions")).toBe(1);
  });

  it("apply refuses until the reply is durably sent (wrong_number_all)", async () => {
    await setFlags(ON);
    const c = await claim();
    expect(await applyOnly(c.actionId)).toMatchObject({ status: "reply_pending", replyState: "pending" });
    await step(c.actionId, "begin_send");
    expect(await applyOnly(c.actionId)).toMatchObject({ status: "reply_pending", replyState: "sending" });
    expect(await step(c.actionId, "begin_send")).toMatchObject({ ok: false, replyState: "sending" }); // never twice
    await step(c.actionId, "sent", randomUUID());
    expect((await applyOnly(c.actionId)).status).toBe("applied");
  });

  describe("crash recovery (lease)", () => {
    it("a live lease is never taken; an expired one is", async () => {
      await setFlags(ON);
      const c = await claim();
      expect(await takeLease(c.actionId)).toMatchObject({ taken: false, reason: "lease_held" });
      await expireLease(c.actionId);
      expect(await takeLease(c.actionId)).toMatchObject({ taken: true, status: "claimed", replyState: "pending" });
      expect(await takeLease(c.actionId)).toMatchObject({ taken: false, reason: "lease_held" }); // re-leased
    });

    it("crash while sending, reply on the thread: recorded as sent with that message, then applies", async () => {
      await setFlags(ON);
      const c = await claim();
      await step(c.actionId, "begin_send");
      const out = randomUUID();
      await db.query(
        `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body, to_address) values ($1, $2, $3, $4, 'sms', 'outbound', $5, $6)`,
        [out, orgId, ids.p1, ids.conv, APPROVED_REPLY_TEXTS.wrong_number, X],
      );
      await expireLease(c.actionId);
      expect(await takeLease(c.actionId)).toMatchObject({ taken: true, status: "claimed", replyState: "sent" });
      const row = (await db.query(`select reply_message_id from public.routing_v2_phone_actions where id = $1`, [c.actionId])).rows[0];
      expect(row.reply_message_id).toBe(out);
      expect((await applyOnly(c.actionId)).status).toBe("applied");
    });

    it("crash while sending, no reply on the thread: closed send_outcome_unknown, nothing applied", async () => {
      await setFlags(ON);
      const before = await snapshot();
      const c = await claim();
      await step(c.actionId, "begin_send");
      await expireLease(c.actionId);
      expect(await takeLease(c.actionId)).toMatchObject({ taken: true, status: "not_applied", reason: "send_outcome_unknown" });
      expect(await applyOnly(c.actionId)).toMatchObject({ status: "replayed", actionStatus: "not_applied" });
      expect(await snapshot()).toEqual(before);
    });

    it("crash after apply before pause: stale until paused, then finished", async () => {
      await setFlags(ON);
      const c = await claim();
      await apply(c.actionId, randomUUID());
      const stale = async () =>
        (await asService(async () => (await db.query(`select action_id from public.fn_routing_v2_phone_action_list_stale(50)`)).rows)).map((r) => r.action_id);
      expect(await stale()).not.toContain(c.actionId); // lease still held
      await expireLease(c.actionId);
      expect(await stale()).toContain(c.actionId);
      const t = await takeLease(c.actionId);
      expect(t).toMatchObject({ taken: true, status: "applied" });
      expect([...t.applied].sort()).toEqual([ids.p1, ids.p2, ids.p3].sort());
      expect(await step(c.actionId, "paused")).toMatchObject({ ok: true });
      await expireLease(c.actionId);
      expect(await stale()).not.toContain(c.actionId);
      expect(await takeLease(c.actionId)).toMatchObject({ taken: false, reason: "finished" });
    });

    it("a bounce is finished when applied (nothing to pause)", async () => {
      await setFlags(ON);
      const c = await claim("bad_number");
      await applyOnly(c.actionId);
      await expireLease(c.actionId);
      expect(await takeLease(c.actionId)).toMatchObject({ taken: false, reason: "finished" });
    });
  });

  it("undo refuses a user without org access", async () => {
    await setFlags(ON);
    const c = await claim();
    await apply(c.actionId, randomUUID());
    await expect(undo(outsiderId, c.actionId)).rejects.toThrow(/FORBIDDEN/);
  });

  it("canary: one property on the phone not eligible = nothing at all", async () => {
    await setFlags({ questions_live: true, wrong_number_all: true, canary_percent: 0, canary_property_ids: [ids.p1, ids.p2] });
    const before = await snapshot();
    expect(await claim()).toEqual({ status: "not_applicable", reason: "canary_excluded" });
    await setFlags({ canary_property_ids: [ids.p1, ids.p2, ids.p3, ids.p5] });
    expect((await claim()).status).toBe("claimed");
    expect(await snapshot()).toEqual(before);
  });

  it("respects suppression: a suppressed phone does nothing; an opted-out/DNC property is skipped", async () => {
    await setFlags(ON);
    await db.query(`update public.properties set outreach_dispo = 'dnc' where id = $1`, [ids.p3]);
    await db.query(`insert into public.sms_phone_suppressions (org_id, phone_e164, source) values ($1, $2, 'test')`, [orgId, X]);
    expect(await claim()).toEqual({ status: "not_applicable", reason: "phone_suppressed" });
    await db.query(`delete from public.sms_phone_suppressions where org_id = $1`, [orgId]);
    const c = await claim();
    const r = await apply(c.actionId, randomUUID());
    // Setting dnc also DNC-locks the row (existing trigger): it is skipped either way.
    expect(r.skipped.find((s: { propertyId: string }) => s.propertyId === ids.p3)?.reason).toMatch(/^(dnc_locked|opted_out_or_dnc)$/);
    expect(await dispo(ids.p3)).toBe("dnc");
  });

  it("an opted-out homeowner contact on another property is skipped, never closed", async () => {
    await setFlags(ON);
    const c4 = randomUUID();
    const p6 = randomUUID();
    await db.query("set local session_replication_role = replica");
    await db.query(`insert into public.contacts (id, org_id, phone_3, sms_opted_out) values ($1, $2, $3, true)`, [c4, orgId, X]);
    await db.query(`insert into public.properties (id, org_id, address, state, status, homeowner_contact_id) values ($1, $2, 'Six', 'MO', 'prospect', $3)`, [p6, orgId, c4]);
    await db.query("set local session_replication_role = origin");
    const c = await claim();
    const r = await apply(c.actionId, randomUUID());
    expect(r.skipped).toEqual(expect.arrayContaining([{ propertyId: p6, reason: "contact_suppressed" }]));
    expect(await dispo(p6)).toBeNull();
  });

  it("source property held or human-owned = not applicable", async () => {
    await setFlags(ON);
    await db.query(`update public.properties set needs_human_attention = true where id = $1`, [ids.p1]);
    expect(await claim()).toEqual({ status: "not_applicable", reason: "source_held" });
  });

  it("a newer seller text between claim and apply = not applied, nothing changed", async () => {
    await setFlags(ON);
    const before = await snapshot();
    const c = await claim();
    await db.query(
      `insert into public.messages (org_id, property_id, conversation_id, channel, direction, body, from_address)
       values ($1, $2, $3, 'sms', 'inbound', 'actually wait', $4)`,
      [orgId, ids.p1, ids.conv, X],
    );
    expect(await apply(c.actionId, randomUUID())).toMatchObject({ status: "not_applied", reason: "superseded_by_newer_inbound" });
    expect(await snapshot()).toEqual(before);
  });

  it("a property joining the phone between claim and apply = not applied", async () => {
    await setFlags(ON);
    const c = await claim();
    await db.query("set local session_replication_role = replica");
    await db.query(`insert into public.properties (org_id, address, state, status, homeowner_contact_id) values ($1, 'New', 'MO', 'prospect', $2)`, [orgId, ids.c1]);
    await db.query("set local session_replication_role = origin");
    expect(await apply(c.actionId, randomUUID())).toMatchObject({ status: "not_applied", reason: "property_set_changed" });
  });

  it("bad_number (bounce) marks only the property it landed on; undo restores it", async () => {
    await setFlags(ON);
    const before = await snapshot();
    const c = await claim("bad_number");
    const r = await apply(c.actionId, null);
    expect(r).toMatchObject({ status: "applied", applied: [ids.p1], skipped: [] });
    expect(await dispo(ids.p1)).toBe("bad_number");
    expect(await dispo(ids.p2)).toBe("not_interested");
    await undo(ownerId, c.actionId);
    expect(await snapshot()).toEqual(before);
  });

  it("phone mismatch with the inbound and non-service callers are refused", async () => {
    await setFlags(ON);
    expect(await claim("wrong_number_all", inbound, Y)).toEqual({ status: "not_applicable", reason: "phone_mismatch" });
    await expect(
      asUser(ownerId, async () => db.query(`select public.fn_routing_v2_phone_action_claim($1, 'wrong_number_all', $2, '{}'::jsonb, 120)`, [inbound, X])),
    ).rejects.toThrow(/permission denied|service role required/);
  });

  it("SQL canary eligibility matches flags.ts isV2Eligible exactly, including malformed configs (fail closed)", async () => {
    const propertyIds = Array.from({ length: 400 }, () => randomUUID());
    const listed = propertyIds.slice(0, 5);
    const configs: unknown[] = [
      {},
      { canary_percent: 0 },
      { canary_percent: 1 },
      { canary_percent: 10 },
      { canary_percent: 37 },
      { canary_percent: 50 },
      { canary_percent: 99 },
      { canary_percent: 100 },
      { canary_percent: 12.0 },
      { canary_property_ids: listed },
      { canary_property_ids: listed.map((id) => id.toUpperCase()), canary_percent: 10 },
      { canary_property_ids: [] , canary_percent: 50 },
      // Malformed: every one must read as nothing eligible.
      { canary_property_ids: [...listed, "not-a-uuid"], canary_percent: 100 },
      { canary_property_ids: [listed[0], 7], canary_percent: 100 },
      { canary_property_ids: listed[0], canary_percent: 100 },
      { canary_property_ids: null, canary_percent: 100 },
      { canary_property_ids: { a: listed[0] }, canary_percent: 100 },
      { canary_percent: "50" },
      { canary_percent: 50.5 },
      { canary_percent: -1 },
      { canary_percent: 101 },
      { canary_percent: null },
      { canary_percent: true },
      { canary_property_ids: listed, canary_percent: 200 },
    ];
    let mismatches = 0;
    let malformedEligible = 0;
    for (const [i, cfg] of configs.entries()) {
      const flags = parseRoutingV2Flags(cfg);
      const sql = (
        await db.query(
          `select t.id::text as id, public.routing_v2_phone_action_eligible($1::jsonb, t.id) as ok from unnest($2::uuid[]) t(id)`,
          [JSON.stringify(cfg), propertyIds],
        )
      ).rows as Array<{ id: string; ok: boolean }>;
      for (const row of sql) {
        const ts = isV2Eligible(flags, row.id);
        if (ts !== row.ok) mismatches += 1;
        if (i >= 12 && row.ok) malformedEligible += 1;
      }
    }
    expect(mismatches).toBe(0);
    expect(malformedEligible).toBe(0);
    // Sanity: the percent configs really do select a stable, non-trivial subset.
    const half = (
      await db.query(`select count(*) filter (where public.routing_v2_phone_action_eligible('{"canary_percent":50}'::jsonb, t.id)) c from unnest($1::uuid[]) t(id)`, [propertyIds])
    ).rows[0].c;
    expect(Number(half)).toBeGreaterThan(120);
    expect(Number(half)).toBeLessThan(280);
  });

  it("a malformed canary config makes the whole phone action not applicable", async () => {
    await setFlags({ questions_live: true, wrong_number_all: true, canary_percent: 100, canary_property_ids: [ids.p1, "bad"] });
    expect(await claim()).toEqual({ status: "not_applicable", reason: "canary_excluded" });
    await setFlags({ canary_property_ids: [], canary_percent: "100" });
    expect(await claim()).toEqual({ status: "not_applicable", reason: "canary_excluded" });
    expect(await count("routing_v2_phone_actions")).toBe(0);
  });

  it("rollback removes every object", async () => {
    await db.query(ROLLBACK);
    const left = (await db.query(`select to_regclass('public.routing_v2_phone_actions') a, to_regclass('public.routing_v2_phone_action_properties') b`)).rows[0];
    expect(left).toEqual({ a: null, b: null });
    const fns = (await db.query(`select count(*) from pg_proc where proname like '%routing_v2_phone%'`)).rows[0].count;
    expect(Number(fns)).toBe(0);
  });
});
