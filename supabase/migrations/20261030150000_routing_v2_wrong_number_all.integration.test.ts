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
  // Drips: active on p2 (target), p4 (other phone) and p5 (skipped); already paused on p3.
  for (const k of ["e2", "e4", "e5", "e3", "seq"]) ids[k] = randomUUID();
  await db.query(`insert into public.sequences (id, org_id, name) values ($1, $2, 'prg drip')`, [ids.seq, orgId]);
  for (const [e, pid, status, reason] of [
    [ids.e2, ids.p2, "active", null],
    [ids.e4, ids.p4, "active", null],
    [ids.e5, ids.p5, "active", null],
    [ids.e3, ids.p3, "paused", "manual"],
  ] as const) {
    await db.query(
      `insert into public.sequence_enrollments (id, org_id, sequence_id, property_id, status, pause_reason) values ($1, $2, $3, $4, $5, $6)`,
      [e, orgId, ids.seq, pid, status, reason],
    );
  }
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

const applyAll = (action = "wrong_number_all", msg = inbound, phone = X, expectedRevision: number | null = null) =>
  asService(async () =>
    (await db.query(`select public.fn_routing_v2_phone_action_apply_all($1, $2, $3, '{}'::jsonb, $4) as r`, [msg, action, phone, expectedRevision])).rows[0].r,
  );
const reply = (actionId: string, sendId: string, to: string, messageId: string | null = null) =>
  asService(async () => (await db.query(`select public.fn_routing_v2_phone_action_reply($1, $2, $3, $4, null) as r`, [actionId, sendId, to, messageId])).rows[0].r);
const recover = (actionId: string) =>
  asService(async () => (await db.query(`select public.fn_routing_v2_phone_action_recover_reply($1) as r`, [actionId])).rows[0].r);
const undo = (userId: string, actionId: string) =>
  asUser(userId, async () => (await db.query(`select public.fn_undo_routing_v2_phone_action($1) as r`, [actionId])).rows[0].r);

const snapshot = async () =>
  (
    await db.query(
      `select id, outreach_dispo, follow_up_at, needs_human_attention, last_ai_escalation_reason from public.properties where org_id = $1 order by id`,
      [orgId],
    )
  ).rows;
const enrollments = async () =>
  (await db.query(`select id, status, pause_reason from public.sequence_enrollments where org_id = $1 order by id`, [orgId])).rows;
const contacts = async () =>
  (await db.query(`select id, phone_1, phone_2, phone_3, sms_opted_out, do_not_contact from public.contacts where org_id = $1 order by id`, [orgId])).rows;
const dispo = async (id: string) =>
  (await db.query(`select outreach_dispo from public.properties where id = $1`, [id])).rows[0].outreach_dispo;
const enrollment = async (id: string) => (await db.query(`select status, pause_reason from public.sequence_enrollments where id = $1`, [id])).rows[0];
const count = async (table: string) => Number((await db.query(`select count(*) from public.${table} where org_id = $1`, [orgId])).rows[0].count);
const everything = async () => ({
  props: await snapshot(),
  enr: await enrollments(),
  actions: await count("routing_v2_phone_actions"),
  audit: await count("routing_v2_phone_action_properties"),
  events: await count("lead_events"),
});
const insertInbound = async (propertyId: string, at: string, body = "hi") => {
  const id = randomUUID();
  await db.query(
    `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body, from_address, created_at)
     values ($1, $2, $3, $4, 'sms', 'inbound', $5, $6, ${at})`,
    [id, orgId, propertyId, randomUUID(), body, X],
  );
  return id;
};

describe("A. atomic apply", () => {
  it("flag off (default): not applicable, writes nothing", async () => {
    const before = await everything();
    expect(await applyAll()).toEqual({ status: "not_applicable", reason: "flag_off" });
    await setFlags({ wrong_number_all: true });
    expect(await applyAll()).toEqual({ status: "not_applicable", reason: "flag_off" });
    await setFlags({ questions_live: true, wrong_number_all: false, canary_percent: 100 });
    expect(await applyAll()).toEqual({ status: "not_applicable", reason: "flag_off" });
    expect(await everything()).toEqual(before);
  });

  it("closes every property for the phone, pauses their drips, audits each, leaves other phones/contacts alone", async () => {
    await setFlags(ON);
    const contactsBefore = await contacts();
    const r = await applyAll();
    expect(r.status).toBe("applied");
    expect(r.replyState).toBe("pending");
    expect(r.sendId).toMatch(/^[0-9a-f-]{36}$/);
    expect([...r.applied].sort()).toEqual([ids.p1, ids.p2, ids.p3].sort());
    expect(r.skipped).toEqual([{ propertyId: ids.p5, reason: "other_phones_on_contact" }]);
    for (const id of [ids.p1, ids.p2, ids.p3]) expect(await dispo(id)).toBe("wrong_number");
    expect(await dispo(ids.p4)).toBeNull();
    expect(await dispo(ids.p5)).toBeNull();
    expect(await contacts()).toEqual(contactsBefore);
    expect(await count("sms_phone_suppressions")).toBe(0);
    // Drips: only the target's ACTIVE drip paused; recorded in the same transaction.
    expect(await enrollment(ids.e2)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
    expect(await enrollment(ids.e3)).toEqual({ status: "paused", pause_reason: "manual" });
    expect((await enrollment(ids.e4)).status).toBe("active");
    expect((await enrollment(ids.e5)).status).toBe("active");
    const audit = (await db.query(`select property_id, outcome, skip_reason, paused_enrollment_ids from public.routing_v2_phone_action_properties where action_id = $1 order by property_id`, [r.actionId])).rows;
    expect(audit).toHaveLength(4);
    expect(audit.find((a) => a.property_id === ids.p2)?.paused_enrollment_ids).toEqual([ids.e2]);
    const events = (await db.query(`select payload from public.lead_events where org_id = $1 and event_type = 'dispo_set'`, [orgId])).rows;
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.payload.auto_accepted === true && e.payload.to === "wrong_number")).toBe(true);
    expect(Number((await db.query(`select count(*) from public.ai_disposition_reviews where org_id = $1`, [orgId])).rows[0].count)).toBe(0);
  });

  it("idempotent under duplicate webhooks: replay returns the same action and send id, writes nothing", async () => {
    await setFlags(ON);
    const r = await applyAll();
    const after = await everything();
    const again = await applyAll();
    expect(again).toMatchObject({ status: "replayed", actionId: r.actionId, sendId: r.sendId, actionStatus: "applied", replyState: "pending" });
    expect(await everything()).toEqual(after);
  });

  it("D. an older inbound from the same phone is superseded (any property); only the newest applies", async () => {
    await setFlags(ON);
    const newer = await insertInbound(ids.p2, "now()");
    const before = await everything();
    expect(await applyAll("wrong_number_all", inbound)).toEqual({ status: "superseded", reason: "newer_inbound_from_phone" });
    expect(await everything()).toEqual(before);
    expect((await applyAll("wrong_number_all", newer)).status).toBe("applied"); // the newest one (on p2) applies
  });

  it("D. the newest inbound applies once; the older one stays superseded afterwards", async () => {
    await setFlags(ON);
    const older = await insertInbound(ids.p1, "now() - interval '10 minutes'");
    expect((await applyAll("wrong_number_all", inbound)).status).toBe("applied");
    expect(await applyAll("wrong_number_all", older)).toEqual({ status: "superseded", reason: "newer_inbound_from_phone" });
    expect(await count("routing_v2_phone_actions")).toBe(1);
  });

  it("canary: one property on the phone not eligible, or a malformed canary = nothing", async () => {
    const before = await everything();
    for (const flags of [
      { questions_live: true, wrong_number_all: true, canary_percent: 0, canary_property_ids: [ids.p1, ids.p2] },
      { canary_percent: 100, canary_property_ids: [ids.p1, "bad"] },
      { canary_property_ids: [], canary_percent: "100" },
    ]) {
      await setFlags(flags);
      expect(await applyAll()).toEqual({ status: "not_applicable", reason: "canary_excluded" });
    }
    expect(await everything()).toEqual(before);
    await setFlags({ canary_percent: 0, canary_property_ids: [ids.p1, ids.p2, ids.p3, ids.p5] });
    expect((await applyAll()).status).toBe("applied");
  });

  it("suppression: a suppressed phone does nothing; DNC property and opted-out contact are skipped", async () => {
    await setFlags(ON);
    await db.query(`insert into public.sms_phone_suppressions (org_id, phone_e164, source) values ($1, $2, 'test')`, [orgId, X]);
    const before = await everything();
    expect(await applyAll()).toEqual({ status: "not_applicable", reason: "phone_suppressed" });
    expect(await everything()).toEqual(before);
    await db.query(`delete from public.sms_phone_suppressions where org_id = $1`, [orgId]);
    await db.query(`update public.properties set outreach_dispo = 'dnc' where id = $1`, [ids.p3]);
    const c4 = randomUUID();
    const p6 = randomUUID();
    await db.query("set local session_replication_role = replica");
    await db.query(`insert into public.contacts (id, org_id, phone_3, sms_opted_out) values ($1, $2, $3, true)`, [c4, orgId, X]);
    await db.query(`insert into public.properties (id, org_id, address, state, status, homeowner_contact_id) values ($1, $2, 'Six', 'MO', 'prospect', $3)`, [p6, orgId, c4]);
    await db.query("set local session_replication_role = origin");
    const r = await applyAll();
    expect(r.skipped.find((s: { propertyId: string }) => s.propertyId === ids.p3)?.reason).toMatch(/^(dnc_locked|opted_out_or_dnc)$/);
    expect(r.skipped).toEqual(expect.arrayContaining([{ propertyId: p6, reason: "contact_suppressed" }]));
    expect(await dispo(ids.p3)).toBe("dnc");
    expect(await dispo(p6)).toBeNull();
  });

  it("source held, or a stale decision revision = not applicable, nothing written", async () => {
    await setFlags(ON);
    const rev = Number((await db.query(`select decision_context_revision from public.properties where id = $1`, [ids.p1])).rows[0].decision_context_revision);
    expect(await applyAll("wrong_number_all", inbound, X, rev + 5)).toEqual({ status: "not_applicable", reason: "stale_decision_context" });
    await db.query(`update public.properties set needs_human_attention = true where id = $1`, [ids.p1]);
    expect(await applyAll("wrong_number_all", inbound, X, null)).toEqual({ status: "not_applicable", reason: "source_held" });
    expect(await count("routing_v2_phone_actions")).toBe(0);
  });

  it("crash during A: any failure rolls back EVERYTHING and the call is retryable", async () => {
    await setFlags(ON);
    const before = await everything();
    await db.query(`
      create or replace function pg_temp.prg_fail() returns trigger language plpgsql as $f$
      begin if new.property_id = '${ids.p3}' then raise exception 'injected failure'; end if; return new; end $f$;
      create trigger prg_fail before insert on public.routing_v2_phone_action_properties for each row execute function pg_temp.prg_fail();`);
    await expect(applyAll()).rejects.toThrow(/injected failure/);
    expect(await everything()).toEqual(before); // no dispo, no pause, no audit, no action, no events
    await db.query(`drop trigger prg_fail on public.routing_v2_phone_action_properties`);
    expect((await applyAll()).status).toBe("applied");
  });

  it("phone mismatch and non-service callers are refused", async () => {
    await setFlags(ON);
    expect(await applyAll("wrong_number_all", inbound, Y)).toEqual({ status: "not_applicable", reason: "phone_mismatch" });
    await expect(
      asUser(ownerId, async () => db.query(`select public.fn_routing_v2_phone_action_apply_all($1, 'wrong_number_all', $2)`, [inbound, X])),
    ).rejects.toThrow(/permission denied|service role required/);
    await expect(asUser(ownerId, async () => db.query(`select * from public.routing_v2_phone_actions`))).resolves.toBeTruthy();
    await expect(asUser(ownerId, async () => db.query(`insert into public.routing_v2_phone_actions (org_id) values ($1)`, [orgId]))).rejects.toThrow(/permission denied/);
  });

  it("bad_number (bounce): only the landed property, no drip pause, reply not needed", async () => {
    await setFlags(ON);
    const r = await applyAll("bad_number");
    expect(r).toMatchObject({ status: "applied", applied: [ids.p1], skipped: [], replyState: "not_needed" });
    expect(await dispo(ids.p1)).toBe("bad_number");
    expect(await dispo(ids.p2)).toBe("not_interested");
    expect((await enrollment(ids.e2)).status).toBe("active");
  });
});

describe("B. reply after commit, keyed by the send id", () => {
  it("pending -> sending happens once; sent needs sending; a wrong send id changes nothing", async () => {
    await setFlags(ON);
    const r = await applyAll();
    expect(await reply(r.actionId, randomUUID(), "sending")).toMatchObject({ ok: false, replyState: "pending" });
    expect(await reply(r.actionId, r.sendId, "sent", randomUUID())).toMatchObject({ ok: false, replyState: "pending" });
    expect(await reply(r.actionId, r.sendId, "sending")).toMatchObject({ ok: true, replyState: "sending" });
    expect(await reply(r.actionId, r.sendId, "sending")).toMatchObject({ ok: false, replyState: "sending" });
    expect(await reply(r.actionId, r.sendId, "skipped")).toMatchObject({ ok: false, replyState: "sending" });
    const out = randomUUID();
    expect(await reply(r.actionId, r.sendId, "sent", out)).toMatchObject({ ok: true, replyState: "sent" });
    expect(await reply(r.actionId, r.sendId, "unknown")).toMatchObject({ ok: false, replyState: "sent" });
    // The properties stay closed whatever happens to the reply.
    expect(await dispo(ids.p1)).toBe("wrong_number");
  });

  it("crash during the send: recovered ONLY by the send id on the source property, never by body or time", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await reply(r.actionId, r.sendId, "sending");
    // Same approved body, same property, after the action — but no send id: not ours.
    await db.query(
      `insert into public.messages (org_id, property_id, conversation_id, channel, direction, body, to_address) values ($1, $2, $3, 'sms', 'outbound', $4, $5)`,
      [orgId, ids.p1, ids.conv, APPROVED_REPLY_TEXTS.wrong_number, X],
    );
    // The send id on ANOTHER property: not ours either.
    await db.query(
      `insert into public.messages (org_id, property_id, conversation_id, channel, direction, body, to_address, idempotency_key) values ($1, $2, $3, 'sms', 'outbound', 'x', $4, $5)`,
      [orgId, ids.p4, randomUUID(), Y, r.sendId],
    );
    expect(await recover(r.actionId)).toMatchObject({ replyState: "unknown", messageId: null });
  });

  it("crash during the send, our row exists: recorded sent with that message", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await reply(r.actionId, r.sendId, "sending");
    const out = randomUUID();
    await db.query(
      `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body, to_address, idempotency_key) values ($1, $2, $3, $4, 'sms', 'outbound', $5, $6, $7)`,
      [out, orgId, ids.p1, ids.conv, APPROVED_REPLY_TEXTS.wrong_number, X, r.sendId],
    );
    expect(await recover(r.actionId)).toMatchObject({ replyState: "sent", messageId: out });
    expect(await recover(r.actionId)).toMatchObject({ replyState: "sent" }); // settled, idempotent
  });

  it("unsettled feed lists only pending/sending replies past the age", async () => {
    await setFlags(ON);
    const r = await applyAll();
    const feed = async (age: number) =>
      (await asService(async () => (await db.query(`select action_id, reply_state from public.fn_routing_v2_phone_action_unsettled_replies($1, 50)`, [age])).rows)).map((x) => x.action_id);
    expect(await feed(0)).toContain(r.actionId);
    expect(await feed(3600)).not.toContain(r.actionId);
    await reply(r.actionId, r.sendId, "skipped");
    expect(await feed(0)).not.toContain(r.actionId);
  });
});

describe("C. undo", () => {
  it("restores every property exactly and resumes exactly the recorded drips; idempotent", async () => {
    await setFlags(ON);
    const before = await snapshot();
    const r = await applyAll();
    const u = await undo(ownerId, r.actionId);
    expect(u.status).toBe("undone");
    expect([...u.restored].sort()).toEqual([ids.p1, ids.p2, ids.p3].sort());
    expect(u.resumed).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect((await enrollment(ids.e2)).status).toBe("active");
    expect(await enrollment(ids.e3)).toEqual({ status: "paused", pause_reason: "manual" }); // not ours: untouched
    expect(await undo(ownerId, r.actionId)).toMatchObject({ status: "already_undone", restored: [], resumed: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it("never overwrites a property a person changed, nor a later hold (both audited)", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await db.query(`update public.properties set outreach_dispo = 'callback_requested' where id = $1`, [ids.p3]);
    await db.query(`update public.properties set needs_human_attention = true, last_ai_escalation_reason = 'person_needs_to_look' where id = $1`, [ids.p2]);
    const u = await undo(ownerId, r.actionId);
    expect(u.status).toBe("partial");
    expect(u.skipped).toEqual(expect.arrayContaining([
      { propertyId: ids.p3, reason: "state_changed" },
      { propertyId: ids.p2, reason: "hold_changed" },
    ]));
    expect(await dispo(ids.p3)).toBe("callback_requested");
    const p2 = (await db.query(`select outreach_dispo, needs_human_attention, last_ai_escalation_reason from public.properties where id = $1`, [ids.p2])).rows[0];
    expect(p2).toEqual({ outreach_dispo: "wrong_number", needs_human_attention: true, last_ai_escalation_reason: "person_needs_to_look" });
    expect((await enrollment(ids.e2)).status).toBe("paused"); // skipped property: its drip stays paused
    const audit = (await db.query(`select count(*) from public.lead_events where org_id = $1 and event_type = 'routing_v2_phone_action_undo_skipped'`, [orgId])).rows[0].count;
    expect(Number(audit)).toBe(2);
    // A reason alone (no flag) is also a later hold.
    await db.query(`update public.properties set needs_human_attention = false, last_ai_escalation_reason = 'x' where id = $1`, [ids.p2]);
    expect((await undo(ownerId, r.actionId)).skipped).toEqual(expect.arrayContaining([{ propertyId: ids.p2, reason: "hold_changed" }]));
  });

  it("phone suppressed now: restores nothing and resumes no drips", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await db.query(`insert into public.sms_phone_suppressions (org_id, phone_e164, source) values ($1, $2, 'stop')`, [orgId, X]);
    const u = await undo(ownerId, r.actionId);
    expect(u).toMatchObject({ status: "partial", restored: [], resumed: 0 });
    expect(u.skipped.every((s: { reason: string }) => s.reason === "phone_suppressed")).toBe(true);
    for (const id of [ids.p1, ids.p2, ids.p3]) expect(await dispo(id)).toBe("wrong_number");
    expect((await enrollment(ids.e2)).status).toBe("paused");
  });

  it("a drip someone else re-paused is not resumed", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await db.query(`update public.sequence_enrollments set pause_reason = 'manual' where id = $1`, [ids.e2]);
    const u = await undo(ownerId, r.actionId);
    expect(u.resumed).toBe(0);
    expect(u.notResumed).toEqual([{ enrollmentId: ids.e2, outcome: "pause_reason_changed" }]);
    expect(await enrollment(ids.e2)).toEqual({ status: "paused", pause_reason: "manual" });
  });

  it("undo before the reply was sent: the reply is skipped and can never start", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await undo(ownerId, r.actionId);
    const row = (await db.query(`select reply_state, reply_reason from public.routing_v2_phone_actions where id = $1`, [r.actionId])).rows[0];
    expect(row).toEqual({ reply_state: "skipped", reply_reason: "undone_before_send" });
    expect(await reply(r.actionId, r.sendId, "sending")).toMatchObject({ ok: false });
    const feed = (await asService(async () => (await db.query(`select action_id from public.fn_routing_v2_phone_action_unsettled_replies(0, 50)`)).rows)).map((x) => x.action_id);
    expect(feed).not.toContain(r.actionId);
  });

  it("refuses a user without org access", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await expect(undo(outsiderId, r.actionId)).rejects.toThrow(/FORBIDDEN/);
  });

  it("bad_number undo restores the landed property", async () => {
    await setFlags(ON);
    const before = await snapshot();
    const r = await applyAll("bad_number");
    await undo(ownerId, r.actionId);
    expect(await snapshot()).toEqual(before);
  });
});

describe("canary twin + rollback", () => {
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

  it("rollback removes every object", async () => {
    await db.query(ROLLBACK);
    const left = (await db.query(`select to_regclass('public.routing_v2_phone_actions') a, to_regclass('public.routing_v2_phone_action_properties') b`)).rows[0];
    expect(left).toEqual({ a: null, b: null });
    const fns = (await db.query(`select count(*) from pg_proc where proname like '%routing_v2_phone%'`)).rows[0].count;
    expect(Number(fns)).toBe(0);
  });
});
