import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { APPROVED_REPLY_TEXTS } from "@/lib/ai-responder/approved-reply-texts";
import { isV2Eligible, parseRoutingV2Flags } from "@/lib/sms-classification/routing-v2/flags";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * 20261030190000: routing v2 PR-G phone-level actions (wrong_number_all, bad_number).
 * Local-only; one rolled-back transaction per test.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261030190000_routing_v2_wrong_number_all.sql"), "utf8"));
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "..", "rollbacks", "20261030190000_routing_v2_wrong_number_all.sql"), "utf8"),
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

/** Insert the persisted v2 decision row for an inbound (routing_v2_shadow_decisions). */
async function decide(
  msg: string,
  over: { road?: string | null; provenance?: unknown; haikuEligibility?: string | null; haiku?: unknown; propertyId?: string; status?: string } = {},
) {
  await db.query(
    `insert into public.routing_v2_shadow_decisions (org_id, property_id, inbound_message_id, status, road, provenance, haiku_eligibility, haiku)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)`,
    [
      orgId,
      over.propertyId ?? ids.p1,
      msg,
      over.status ?? "decided",
      "road" in over ? over.road : "wrong_number_close",
      JSON.stringify(over.provenance ?? { by: "jev", row: "3", step: "wrong", signal: "wrong_person", probability: 0.9 }),
      over.haikuEligibility ?? null,
      over.haiku === undefined ? null : JSON.stringify(over.haiku),
    ],
  );
}

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
  // The persisted v2 decision for the inbound (PR-A shadow log): wrong person at 0.9, no Haiku band.
  await decide(inbound);
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

const applyAll = (action = "wrong_number_all", msg = inbound, phone = X, expectedRevision: number | null = null, decision: unknown = { wrong_scope: "all" }) =>
  asService(async () =>
    (await db.query(`select public.fn_routing_v2_phone_action_apply_all($1, $2, $3, $4::jsonb, $5) as r`, [msg, action, phone, JSON.stringify(decision), expectedRevision])).rows[0].r,
  );
/** Make the source inbound a "no SMS capabilities" bounce, with its persisted code-check decision. */
const asBounce = async () => {
  await db.query("set local session_replication_role = replica");
  await db.query(`update public.messages set body = 'This number has no SMS capabilities' where id = $1`, [inbound]);
  await db.query("set local session_replication_role = origin");
  await db.query(`update public.routing_v2_shadow_decisions set road = 'bad_number', provenance = '{"by":"code","check":"bad_number"}' where inbound_message_id = $1`, [inbound]);
};
const reply = (actionId: string, sendId: string, to: string, messageId: string | null = null) =>
  asService(async () => (await db.query(`select public.fn_routing_v2_phone_action_reply($1, $2, $3, $4, null) as r`, [actionId, sendId, to, messageId])).rows[0].r);
const releaseFence = (actionId: string) =>
  asService(async () => (await db.query(`select public.fn_routing_v2_phone_action_release_fence($1) as r`, [actionId])).rows[0].r);
const passFence = (actionId: string) =>
  db.query(`update public.routing_v2_phone_actions set fence_at = clock_timestamp() - interval '1 second' where id = $1`, [actionId]);
/** Fence passed, no newer inbound: reply released to pending. */
const toPending = async (actionId: string) => {
  await passFence(actionId);
  expect((await releaseFence(actionId)).replyState).toBe("pending");
};
/** Age a `sending` row past the 120 s provider-timeout lease (test clock shortcut). */
const expireSendLease = (actionId: string) =>
  db.query(`update public.routing_v2_phone_actions set sending_at = clock_timestamp() - interval '121 seconds' where id = $1`, [actionId]);
const registerGlobalDnc = async (phone = X) => {
  await db.query("savepoint reg");
  await db.query("set local session_replication_role = replica");
  await db.query(
    `insert into public.global_phone_dnc_registry (org_id, phone_e164, first_consumer_id, first_source_event_id, first_evidence_sha256)
     values ($1, $2, gen_random_uuid(), 'prg-test', repeat('a', 64))`,
    [orgId, phone],
  );
  await db.query("set local session_replication_role = origin");
  await db.query("release savepoint reg");
};
const sendAllowed = (actionId: string) =>
  asService(async () => (await db.query(`select public.fn_routing_v2_phone_action_send_allowed($1) as ok`, [actionId])).rows[0].ok);
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
    expect(r.replyState).toBe("awaiting_fence");
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
    expect(again).toMatchObject({ status: "replayed", actionId: r.actionId, sendId: r.sendId, actionStatus: "applied", replyState: "awaiting_fence" });
    expect(await everything()).toEqual(after);
  });

  it("D. an older inbound from the same phone is superseded (any property); only the newest applies", async () => {
    await setFlags(ON);
    const newer = await insertInbound(ids.p2, "now() - interval '40 seconds'");
    await decide(newer, { propertyId: ids.p2 });
    const before = await everything();
    expect(await applyAll("wrong_number_all", inbound)).toEqual({ status: "superseded", reason: "newer_inbound_from_phone" });
    expect(await everything()).toEqual(before);
    expect((await applyAll("wrong_number_all", newer)).status).toBe("applied"); // the newest one (on p2) applies
  });

  it("D. the newest inbound applies once; the older one stays superseded afterwards", async () => {
    await setFlags(ON);
    const older = await insertInbound(ids.p1, "now() - interval '10 minutes'");
    await decide(older);
    expect((await applyAll("wrong_number_all", inbound)).status).toBe("applied");
    expect(await applyAll("wrong_number_all", older)).toEqual({ status: "superseded", reason: "newer_inbound_from_phone" });
    expect(await count("routing_v2_phone_actions")).toBe(1);
  });

  it("settle window: an inbound under 30 s old is not_settled and nothing is written", async () => {
    await setFlags(ON);
    const fresh = await insertInbound(ids.p1, "clock_timestamp()");
    await decide(fresh);
    const before = await everything();
    const r = await applyAll("wrong_number_all", fresh);
    expect(r).toMatchObject({ status: "not_settled", reason: "inbound_settle_window" });
    expect(r.retryAfterSeconds).toBeGreaterThan(25);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(30);
    expect(await everything()).toEqual(before);
    // Past the window (and with this fresh text now the newest), the older trigger is superseded.
    expect(await applyAll("wrong_number_all", inbound)).toEqual({ status: "superseded", reason: "newer_inbound_from_phone" });
    await db.query("set local session_replication_role = replica");
    await db.query(`update public.messages set created_at = now() - interval '31 seconds' where id = $1`, [fresh]);
    await db.query("set local session_replication_role = origin");
    expect((await applyAll("wrong_number_all", fresh)).status).toBe("applied");
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

  it("never trusts the caller's decision: re-derived from the persisted v2 decision row", async () => {
    await setFlags(ON);
    const before = await everything();
    // Caller passes {} (no scope) → refused.
    expect(await applyAll("wrong_number_all", inbound, X, null, {})).toEqual({ status: "not_applicable", reason: "scope_not_all" });
    // Caller claims a bounce that the decision row does not show → refused.
    expect(await applyAll("bad_number")).toEqual({ status: "not_applicable", reason: "decision_not_bounce" });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ road: "not_interested_drip" }, "decision_not_wrong_person"],
      [{ provenance: { by: "jev", signal: "already_sold", probability: 0.9 } }, "decision_not_wrong_person"],
      [{ provenance: { by: "jev", signal: "wrong_person", probability: 0.59 } }, "decision_not_wrong_person"],
      [{ provenance: { by: "jev", signal: "wrong_person", probability: "0.9" } }, "decision_not_wrong_person"],
      [{ provenance: { by: "code", check: "bad_number" } }, "decision_not_wrong_person"],
      [{ haikuEligibility: "decider_band" }, "haiku_not_confirmed"], // band, Haiku never asked
      [{ haikuEligibility: "decider_band", haiku: { final_road: "not_interested_drip", hold: false } }, "haiku_not_confirmed"],
      [{ haikuEligibility: "decider_band", haiku: { final_road: null, hold: true } }, "haiku_not_confirmed"],
      [{ status: "failed", road: null }, "no_decision_record"],
    ];
    for (const [over, reason] of cases) {
      await db.query(`delete from public.routing_v2_shadow_decisions where inbound_message_id = $1`, [inbound]);
      await decide(inbound, over);
      expect(await applyAll(), JSON.stringify(over)).toEqual({ status: "not_applicable", reason });
    }
    // Missing decision row.
    await db.query(`delete from public.routing_v2_shadow_decisions where inbound_message_id = $1`, [inbound]);
    expect(await applyAll()).toEqual({ status: "not_applicable", reason: "no_decision_record" });
    // A decision row for another property is not this inbound's.
    await decide(inbound, { propertyId: ids.p2 });
    expect(await applyAll()).toEqual({ status: "not_applicable", reason: "no_decision_record" });
    expect(await everything()).toEqual(before);
  });

  it("band rule: Jev 0.65 + Haiku unsure (Jev's road stands) qualifies; 0.55 + unsure does not", async () => {
    await setFlags(ON);
    await db.query(`delete from public.routing_v2_shadow_decisions where inbound_message_id = $1`, [inbound]);
    await decide(inbound, {
      provenance: { by: "jev", signal: "wrong_person", probability: 0.55 },
      haikuEligibility: "decider_band",
      haiku: { asked: true, option: "needs_person", final_road: "wrong_number_close", final_by: "jev_haiku_unsure", hold: false },
    });
    expect(await applyAll()).toEqual({ status: "not_applicable", reason: "decision_not_wrong_person" });
    await db.query(`update public.routing_v2_shadow_decisions set provenance = jsonb_set(provenance, '{probability}', '0.65') where inbound_message_id = $1`, [inbound]);
    expect((await applyAll()).status).toBe("applied");
  });

  it("bounce needs both the recorded code check and the bounce text", async () => {
    await setFlags(ON);
    await db.query(`update public.routing_v2_shadow_decisions set road = 'bad_number', provenance = '{"by":"code","check":"bad_number"}' where inbound_message_id = $1`, [inbound]);
    expect(await applyAll("bad_number")).toEqual({ status: "not_applicable", reason: "decision_not_bounce" }); // body is "wrong number"
    await asBounce();
    expect((await applyAll("bad_number")).status).toBe("applied");
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
    await asBounce();
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
    expect(await reply(r.actionId, r.sendId, "sending")).toMatchObject({ ok: false, replyState: "awaiting_fence" }); // fence first
    await toPending(r.actionId);
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
    await toPending(r.actionId);
    await reply(r.actionId, r.sendId, "sending");
    await expireSendLease(r.actionId);
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
    await toPending(r.actionId);
    await reply(r.actionId, r.sendId, "sending");
    await expireSendLease(r.actionId);
    const out = randomUUID();
    await db.query(
      `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body, to_address, idempotency_key, status, external_id) values ($1, $2, $3, $4, 'sms', 'outbound', $5, $6, $7, 'sent', 'SM123')`,
      [out, orgId, ids.p1, ids.conv, APPROVED_REPLY_TEXTS.wrong_number, X, r.sendId],
    );
    expect(await recover(r.actionId)).toMatchObject({ replyState: "sent", messageId: out });
    expect(await recover(r.actionId)).toMatchObject({ replyState: "sent" }); // settled, idempotent
  });

  it("recovery maps the message status explicitly; nothing is assumed sent", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await toPending(r.actionId);
    await reply(r.actionId, r.sendId, "sending");
    await expireSendLease(r.actionId);
    const out = randomUUID();
    await db.query(
      `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body, to_address, idempotency_key, status) values ($1, $2, $3, $4, 'sms', 'outbound', $5, $6, $7, 'pending')`,
      [out, orgId, ids.p1, ids.conv, APPROVED_REPLY_TEXTS.wrong_number, X, r.sendId],
    );
    const cases: Array<[string, string | null, Record<string, unknown> | null, string]> = [
      ["pending", null, null, "unknown"],
      ["queued", null, null, "unknown"],
      ["paused", null, null, "unknown"],
      ["received", "SM1", null, "unknown"], // any status outside the map
      ["bounced", "SM1", null, "unknown"],
      ["sent", null, null, "unknown"], // terminal without a provider receipt
      ["sent", "SM1", { providerOutcome: "provider_unknown" }, "unknown"],
      ["failed", null, null, "failed"],
      ["sent", "SM1", null, "sent"],
      ["delivered", "SM1", null, "sent"],
    ];
    for (const [status, ext, meta, expected] of cases) {
      await db.query(`update public.routing_v2_phone_actions set reply_state = 'sending' where id = $1`, [r.actionId]);
      await db.query(`update public.messages set status = $2, external_id = $3, metadata = $4::jsonb where id = $1`, [out, status, ext, meta ? JSON.stringify(meta) : null]);
      expect((await recover(r.actionId)).replyState, `${status}/${ext}/${JSON.stringify(meta)}`).toBe(expected);
    }
  });

  it("refuse-after-insert crash: a pending row that send.ts then marks failed is never recorded sent", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await toPending(r.actionId);
    await reply(r.actionId, r.sendId, "sending");
    await expireSendLease(r.actionId);
    const out = randomUUID();
    await db.query(
      `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body, to_address, idempotency_key, status) values ($1, $2, $3, $4, 'sms', 'outbound', $5, $6, $7, 'pending')`,
      [out, orgId, ids.p1, ids.conv, APPROVED_REPLY_TEXTS.wrong_number, X, r.sendId],
    );
    // send.ts refuses before the provider and marks its own row failed; recovery runs after.
    await db.query(`update public.messages set status = 'failed', error_message = 'blocked_before_provider' where id = $1`, [out]);
    expect(await recover(r.actionId)).toMatchObject({ replyState: "failed", reason: "message_failed" });
    // Had recovery run while the row was still pending, it would have said unknown, not sent.
    await db.query(`update public.routing_v2_phone_actions set reply_state = 'sending' where id = $1`, [r.actionId]);
    await db.query(`update public.messages set status = 'pending' where id = $1`, [out]);
    expect((await recover(r.actionId)).replyState).toBe("unknown");
  });

  it("unsettled feed lists fenced replies only once fence_at passed, then pending/sending past the age", async () => {
    await setFlags(ON);
    const r = await applyAll();
    const feed = async (age: number) =>
      (await asService(async () => (await db.query(`select action_id, reply_state from public.fn_routing_v2_phone_action_unsettled_replies($1, 50)`, [age])).rows)).map((x) => x.action_id);
    expect(await feed(0)).not.toContain(r.actionId); // awaiting_fence, fence not passed yet
    await passFence(r.actionId);
    expect(await feed(0)).toContain(r.actionId);
    expect(await feed(3600)).not.toContain(r.actionId);
    await releaseFence(r.actionId);
    expect(await feed(0)).toContain(r.actionId); // pending
    await reply(r.actionId, r.sendId, "skipped");
    expect(await feed(0)).not.toContain(r.actionId);
  });
});

describe("global DNC registry (registry-only phone)", () => {
  it("A: a phone on the global DNC registry → suppressed, nothing written", async () => {
    await setFlags(ON);
    await registerGlobalDnc();
    const before = await everything();
    expect(await applyAll()).toEqual({ status: "suppressed", reason: "global_dnc_registry" });
    expect(await everything()).toEqual(before);
  });

  it("undo: listed now → restores nothing and resumes nothing (audited)", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await registerGlobalDnc();
    const snap = await snapshot();
    const u = await undo(ownerId, r.actionId);
    expect(u).toMatchObject({ status: "partial", restored: [], resumed: 0 });
    expect(u.skipped.length).toBeGreaterThan(0);
    expect(u.skipped.every((x: { reason: string }) => x.reason === "global_dnc_registry")).toBe(true);
    expect(await snapshot()).toEqual(snap);
    expect((await enrollment(ids.e2)).status).toBe("paused");
  });

  it("send gate: listed after A → the fence release refuses, pending -> sending refuses, and the provider-boundary check is false", async () => {
    await setFlags(ON);
    // Fence release refuses.
    const r = await applyAll();
    await passFence(r.actionId);
    await registerGlobalDnc();
    expect(await releaseFence(r.actionId)).toMatchObject({ replyState: "skipped", reason: "suppressed_at_send" });
    expect(await reply(r.actionId, r.sendId, "sending")).toMatchObject({ ok: false, replyState: "skipped" });
    expect(await sendAllowed(r.actionId)).toBe(false);
  });

  it("send gate: listed after the release → pending -> sending refuses (skipped)", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await toPending(r.actionId);
    await registerGlobalDnc();
    expect(await reply(r.actionId, r.sendId, "sending")).toMatchObject({ ok: false, replyState: "skipped", reason: "suppressed_at_send" });
  });

  it("provider-boundary check: true while sending and clean; false once listed", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await toPending(r.actionId);
    await reply(r.actionId, r.sendId, "sending");
    expect(await sendAllowed(r.actionId)).toBe(true);
    await registerGlobalDnc();
    expect(await sendAllowed(r.actionId)).toBe(false);
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

  it("never overwrites a property a person changed, nor one that is held now (both audited)", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await db.query(`update public.properties set outreach_dispo = 'callback_requested' where id = $1`, [ids.p3]);
    await db.query(`update public.properties set needs_human_attention = true, last_ai_escalation_reason = 'person_needs_to_look' where id = $1`, [ids.p2]);
    const u = await undo(ownerId, r.actionId);
    expect(u.status).toBe("partial");
    expect(u.skipped).toEqual(expect.arrayContaining([
      { propertyId: ids.p3, reason: "state_changed" },
      { propertyId: ids.p2, reason: "held" },
    ]));
    expect(await dispo(ids.p3)).toBe("callback_requested");
    const p2 = (await db.query(`select outreach_dispo, needs_human_attention, last_ai_escalation_reason from public.properties where id = $1`, [ids.p2])).rows[0];
    expect(p2).toEqual({ outreach_dispo: "wrong_number", needs_human_attention: true, last_ai_escalation_reason: "person_needs_to_look" });
    expect((await enrollment(ids.e2)).status).toBe("paused"); // skipped property: its drip stays paused
    const audit = (await db.query(`select count(*) from public.lead_events where org_id = $1 and event_type = 'routing_v2_phone_action_undo_skipped'`, [orgId])).rows[0].count;
    expect(Number(audit)).toBe(2);
    // Once the hold is dismissed, undo restores the dispo and leaves the hold fields as they are now.
    await db.query(`update public.properties set needs_human_attention = false, last_ai_escalation_reason = 'x' where id = $1`, [ids.p2]);
    const again = await undo(ownerId, r.actionId);
    expect(again.restored).toEqual([ids.p2]);
    const p2b = (await db.query(`select outreach_dispo, needs_human_attention, last_ai_escalation_reason from public.properties where id = $1`, [ids.p2])).rows[0];
    expect(p2b).toEqual({ outreach_dispo: "not_interested", needs_human_attention: false, last_ai_escalation_reason: "x" });
  });

  it("ABA: a pre-existing reason, A, then a VA raises and dismisses a hold → A and undo never touch the hold fields", async () => {
    await setFlags(ON);
    // p2 starts with last_ai_escalation_reason = 'old_reason' (fixture) and no hold.
    const r = await applyAll();
    let p2 = (await db.query(`select outreach_dispo, needs_human_attention, last_ai_escalation_reason, last_ai_escalation_at from public.properties where id = $1`, [ids.p2])).rows[0];
    expect(p2).toMatchObject({ outreach_dispo: "wrong_number", needs_human_attention: false, last_ai_escalation_reason: "old_reason" }); // A left it alone
    // A VA raises a hold, then dismisses it (fields cleared, as the dismiss flow does).
    await db.query(`update public.properties set needs_human_attention = true, last_ai_escalation_reason = 'va_hold', last_ai_escalation_at = now() where id = $1`, [ids.p2]);
    await db.query(`update public.properties set needs_human_attention = false, last_ai_escalation_reason = null where id = $1`, [ids.p2]);
    const atAfterVa = (await db.query(`select last_ai_escalation_at from public.properties where id = $1`, [ids.p2])).rows[0].last_ai_escalation_at;
    const u = await undo(ownerId, r.actionId);
    expect(u.restored).toEqual(expect.arrayContaining([ids.p2]));
    p2 = (await db.query(`select outreach_dispo, needs_human_attention, last_ai_escalation_reason, last_ai_escalation_at from public.properties where id = $1`, [ids.p2])).rows[0];
    // Dispo restored; the stale 'old_reason' is NOT brought back; hold fields exactly as the VA left them.
    expect(p2.outreach_dispo).toBe("not_interested");
    expect(p2.needs_human_attention).toBe(false);
    expect(p2.last_ai_escalation_reason).toBeNull();
    expect(p2.last_ai_escalation_at).toEqual(atAfterVa);
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
    expect(u.notResumed).toEqual([{ enrollmentId: ids.e2, outcome: "not_this_actions_pause" }]);
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

  it("undo takes a SHARE lock on sms_phone_suppressions: concurrent inserts wait; a held conflicting lock = busy, nothing changed", async () => {
    await setFlags(ON);
    const r = await applyAll();
    const other = new Client({ connectionString: url });
    await other.connect();
    try {
      // 1. Another writer is mid-insert (ROW EXCLUSIVE held): undo gives up after lock_timeout, changes nothing.
      await other.query("begin");
      await other.query("lock table public.sms_phone_suppressions in row exclusive mode");
      const t0 = Date.now();
      expect(await undo(ownerId, r.actionId)).toMatchObject({ status: "busy", restored: [] });
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(await dispo(ids.p1)).toBe("wrong_number");
      await other.query("rollback");
      // 2. Undo holds SHARE until its transaction ends: another writer's insert cannot slip in.
      expect((await undo(ownerId, r.actionId)).status).toBe("undone");
      await other.query("begin");
      await other.query("set local lock_timeout = '300ms'");
      await expect(
        other.query(`insert into public.sms_phone_suppressions (org_id, phone_e164, source) values ($1, $2, 'stop')`, [randomUUID(), X]),
      ).rejects.toThrow(/lock timeout/);
      await other.query("rollback");
    } finally {
      await other.end();
    }
  });

  it("undo never resumes a later pause with the same reason (person resumed, a later inbound re-paused)", async () => {
    await setFlags(ON);
    const r = await applyAll();
    const tok = (await db.query(`select routing_v2_pause_token, updated_at from public.sequence_enrollments where id = $1`, [ids.e2])).rows[0];
    expect(tok.routing_v2_pause_token).toBe(r.actionId);
    // A person resumes it, then a later inbound pauses it again for inbound_reply.
    await db.query(`update public.sequence_enrollments set status = 'active', pause_reason = null, updated_at = now() where id = $1`, [ids.e2]);
    await db.query(`update public.sequence_enrollments set status = 'paused', pause_reason = 'inbound_reply', updated_at = $2 where id = $1`, [ids.e2, tok.updated_at]);
    const after = (await db.query(`select routing_v2_pause_token from public.sequence_enrollments where id = $1`, [ids.e2])).rows[0];
    expect(after.routing_v2_pause_token).toBeNull(); // the trigger cleared A's token
    const u = await undo(ownerId, r.actionId);
    expect(u.resumed).toBe(0);
    expect(u.notResumed).toEqual([{ enrollmentId: ids.e2, outcome: "not_this_actions_pause" }]);
    expect(await enrollment(ids.e2)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
  });

  it("refuses a user without org access", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await expect(undo(outsiderId, r.actionId)).rejects.toThrow(/FORBIDDEN/);
  });

  it("bad_number undo restores the landed property", async () => {
    await setFlags(ON);
    const before = await snapshot();
    await asBounce();
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

});

describe("B0. post-commit fence and undo/send serialization", () => {
  // A second connection writes messages here. Creating this migration's FKs inside the test
  // transaction would lock `messages` against it, so this block installs the migration
  // COMMITTED on the isolated stack first and removes it afterwards.
  const admin = new Client({ connectionString: url });
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`begin; ${MIGRATION}; commit;`);
  });
  afterAll(async () => {
    await admin.query(`begin; ${ROLLBACK}; commit;`);
    await admin.end();
  });

  it("before fence_at the reply stays awaiting_fence with a retry delay", async () => {
    await setFlags(ON);
    const r = await applyAll();
    const f = await releaseFence(r.actionId);
    expect(f.replyState).toBe("awaiting_fence");
    expect(f.retryAfterSeconds).toBeGreaterThan(0);
    expect(f.retryAfterSeconds).toBeLessThanOrEqual(10);
    const row = (await db.query(`select fence_at - created_at as gap from public.routing_v2_phone_actions where id = $1`, [r.actionId])).rows[0];
    expect(row.gap).toBeTruthy();
  });

  it("no newer inbound: after the fence the reply is released and can be sent", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await passFence(r.actionId);
    expect(await releaseFence(r.actionId)).toMatchObject({ replyState: "pending" });
    expect(await reply(r.actionId, r.sendId, "sending")).toMatchObject({ ok: true });
    expect(await reply(r.actionId, r.sendId, "sent", randomUUID())).toMatchObject({ ok: true, replyState: "sent" });
    expect(await dispo(ids.p1)).toBe("wrong_number");
  });

  it("a newer inbound committed by another connection while A holds its locks: after the fence no reply, properties unchanged, needs-person hold, audited; the person undo keeps its full check", async () => {
    await setFlags(ON);
    const before = await snapshot();
    const r = await applyAll(); // our transaction still holds A's advisory + row locks
    expect((await enrollment(ids.e2)).status).toBe("paused");
    const other = new Client({ connectionString: url });
    await other.connect();
    const late = randomUUID();
    try {
      // The live inbound path, committing late in its own transaction (FKs point at this test's
      // uncommitted fixtures, so the insert skips them; it touches none of A's locked rows).
      await other.query("set session_replication_role = replica");
      await other.query(
        `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body, from_address, created_at)
         values ($1, $2, $3, $4, 'sms', 'inbound', 'actually this is me', $5, now())`,
        [late, orgId, ids.p2, randomUUID(), X],
      );
      await passFence(r.actionId);
      const afterA = await snapshot();
      const f = await releaseFence(r.actionId);
      expect(f).toMatchObject({ replyState: "skipped", reason: "superseded_after_commit", newerInboundMessageId: late, holdSet: true });
      // Nothing is undone automatically: every property exactly as A left it, except the hold.
      const now = await snapshot();
      for (const row of afterA) {
        const cur = now.find((n) => n.id === row.id)!;
        if (row.id === ids.p1) {
          expect(cur).toEqual({ ...row, needs_human_attention: true, last_ai_escalation_reason: "nine_needs_person" });
        } else {
          expect(cur).toEqual(row);
        }
      }
      expect((await enrollment(ids.e2)).status).toBe("paused");
      const action = (await db.query(`select status, reply_state, reply_reason from public.routing_v2_phone_actions where id = $1`, [r.actionId])).rows[0];
      expect(action).toEqual({ status: "applied", reply_state: "skipped", reply_reason: "superseded_after_commit" });
      expect(await reply(r.actionId, r.sendId, "sending")).toMatchObject({ ok: false });
      const audit = (await db.query(`select payload from public.lead_events where org_id = $1 and event_type = 'routing_v2_phone_action_superseded_after_commit'`, [orgId])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].payload).toMatchObject({ phone_action_id: r.actionId, newer_inbound_message_id: late, hold_set: true, hold_reason: "nine_needs_person" });
      // A second release is a no-op.
      expect((await releaseFence(r.actionId)).replyState).toBe("skipped");
      // The person: the held source property is skipped by the normal undo (full checks)…
      const u1 = await undo(ownerId, r.actionId);
      expect(u1.skipped).toEqual(expect.arrayContaining([{ propertyId: ids.p1, reason: "held" }]));
      // …and once they dismiss the hold, the normal undo restores it (revision check still on).
      await db.query(`update public.properties set needs_human_attention = false, last_ai_escalation_reason = null where id = $1`, [ids.p1]);
      const u2 = await undo(ownerId, r.actionId);
      expect(u2.status).toBe("undone");
      const restored = await snapshot();
      expect(restored.map((x) => [x.id, x.outreach_dispo])).toEqual(before.map((x) => [x.id, x.outreach_dispo]));
    } finally {
      await other.query("delete from public.messages where id = $1", [late]);
      await other.end();
    }
  });

  describe("global DNC concurrency (committed fixtures, two connections)", () => {
    const BARRIER_NOTE = "both orders: A first, DNC first";
    type Seed = { org: string; consumer: string; contact: string; property: string; inbound: string; phone: string };
    const seedCommitted = async (): Promise<Seed> => {
      // Release this file's per-test transaction (its in-transaction migration DDL holds table
      // locks the two real connections need); afterEach's rollback then ends the fresh one.
      await db.query("rollback");
      await db.query("begin");
      const sd = {
        org: randomUUID(), consumer: randomUUID(), contact: randomUUID(), property: randomUUID(), inbound: randomUUID(),
        phone: `+1913${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
      };
      await admin.query("begin");
      await admin.query("insert into public.organizations (id, name) values ($1, $2)", [sd.org, `prg dnc race ${sd.org}`]);
      await admin.query(
        `insert into public.ai_responder_configs (org_id, system_prompt, active, routing_v2_flags)
         values ($1, 'x', true, $2::jsonb)`,
        [sd.org, JSON.stringify({ questions_live: true, wrong_number_all: true, canary_percent: 100 })],
      );
      await admin.query(
        `insert into public.webhook_consumers (id, org_id, name, secret_hash, consumer_type, default_source)
         values ($1, $2, $3, $4, 'switchboard_contact_preference', null)`,
        [sd.consumer, sd.org, `prg ${sd.consumer}`, sd.consumer.replaceAll("-", "").padEnd(64, "0")],
      );
      await admin.query(`insert into public.contacts (id, org_id, phone_1, phone_1_type) values ($1, $2, $3, 'mobile')`, [sd.contact, sd.org, sd.phone]);
      await admin.query(
        `insert into public.properties (id, org_id, address, state, status, homeowner_contact_id) values ($1, $2, 'Race St', 'MO', 'prospect', $3)`,
        [sd.property, sd.org, sd.contact],
      );
      await admin.query(
        `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body, from_address, created_at)
         values ($1, $2, $3, $4, 'sms', 'inbound', 'wrong number', $5, now() - interval '1 minute')`,
        [sd.inbound, sd.org, sd.property, randomUUID(), sd.phone],
      );
      await admin.query(
        `insert into public.routing_v2_shadow_decisions (org_id, property_id, inbound_message_id, status, road, provenance)
         values ($1, $2, $3, 'decided', 'wrong_number_close', $4::jsonb)`,
        [sd.org, sd.property, sd.inbound, JSON.stringify({ by: "jev", signal: "wrong_person", probability: 0.9 })],
      );
      await admin.query("commit");
      return sd;
    };
    const service = async () => {
      const c = new Client({ connectionString: url });
      await c.connect();
      await c.query("select set_config('request.jwt.claim.role', 'service_role', false)");
      return c;
    };
    const applyOn = (c: Client, sd: Seed) =>
      c.query(`select public.fn_routing_v2_phone_action_apply_all($1, 'wrong_number_all', $2, '{"wrong_scope":"all"}'::jsonb, null) as r`, [sd.inbound, sd.phone]);
    const dncOn = (c: Client, sd: Seed) => {
      const key = randomUUID();
      const evidence = createHash("sha256")
        .update(`switchboard_contact_preference_v1\0${key}\0explicit_do_not_contact\0analysis:global_dnc_requested`, "utf8")
        .digest("hex");
      return c.query(
        `select public.apply_switchboard_contact_preferences(
           $1, $2, $3, $4, 'provider_call', 'contact_preference.explicit',
           $5, $6, 'analysis:global_dnc_requested', null, now(), $7, $8, null, true, false,
           'explicit_do_not_contact', $9, null, null, null, null) as r`,
        [sd.org, sd.consumer, key, "a".repeat(64), `source-${key}`, `call-${key}`, `correlation-${key}`, sd.phone, evidence],
      );
    };
    const settledWithin = async <T,>(p: Promise<T>, ms: number) =>
      Promise.race([p.then(() => "settled", () => "settled"), new Promise<string>((res) => setTimeout(() => res("pending"), ms))]);
    const dncLanded = async (sd: Seed) => {
      const reg = (await admin.query(`select count(*) from public.global_phone_dnc_registry where org_id = $1 and phone_e164 = $2`, [sd.org, sd.phone])).rows[0].count;
      const c = (await admin.query(`select do_not_contact from public.contacts where id = $1`, [sd.contact])).rows[0];
      return Number(reg) === 1 && c.do_not_contact === true;
    };

    it(`A holds its transaction open; a global DNC for the same phone waits, then lands (${BARRIER_NOTE})`, async () => {
      const sd = await seedCommitted();
      const c1 = await service();
      const c2 = await service();
      try {
        await c1.query("begin");
        const a = (await applyOn(c1, sd)).rows[0].r;
        expect(a.status).toBe("applied");
        const dnc = dncOn(c2, sd);
        expect(await settledWithin(dnc, 400)).toBe("pending"); // queued behind A's shared barrier, no deadlock
        await c1.query("commit");
        const res = (await dnc).rows[0].r; // must not throw (no deadlock / abort)
        expect(res).toBeTruthy();
        expect(await dncLanded(sd)).toBe(true);
      } finally {
        await c1.end();
        await c2.end();
      }
    });

    it("interleaved: A is mid-flight (contacts locked, waiting on a property row) when a global DNC starts — no deadlock, both finish, the DNC lands", async () => {
      // Without the barrier-first rule this is the deadlock: A holds the contact row, the DNC
      // takes the exclusive barrier and waits for the contact, then A's property update asks for
      // the shared barrier. With it, the DNC queues behind A's shared barrier instead.
      const sd = await seedCommitted();
      const c1 = await service();
      const c2 = await service();
      const c3 = new Client({ connectionString: url });
      await c3.connect();
      try {
        await c3.query("begin");
        await c3.query("select 1 from public.properties where id = $1 for update", [sd.property]);
        const a = applyOn(c1, sd);
        expect(await settledWithin(a, 400)).toBe("pending"); // A is past its contact locks, blocked on the property row
        const dnc = dncOn(c2, sd);
        expect(await settledWithin(dnc, 400)).toBe("pending");
        await c3.query("commit");
        const [ra, rd] = await Promise.allSettled([a, dnc]);
        expect(ra.status, ra.status === "rejected" ? String(ra.reason) : "").toBe("fulfilled");
        expect(rd.status, rd.status === "rejected" ? String(rd.reason) : "").toBe("fulfilled");
        expect(await dncLanded(sd)).toBe(true);
      } finally {
        await c1.end();
        await c2.end();
        await c3.end();
      }
    });

    it("a global DNC holds its transaction open; A waits at the barrier (before any contact/property lock), then completes; the DNC lands", async () => {
      const sd = await seedCommitted();
      const c1 = await service();
      const c2 = await service();
      try {
        await c2.query("begin");
        await dncOn(c2, sd); // exclusive barrier + contact locks held until commit
        const a = applyOn(c1, sd);
        expect(await settledWithin(a, 400)).toBe("pending");
        await c2.query("commit");
        const r = (await a).rows[0].r; // no deadlock, no error
        expect(r).toEqual({ status: "suppressed", reason: "global_dnc_registry" }); // sees the committed DNC, writes nothing
        expect(await dncLanded(sd)).toBe(true);
      } finally {
        await c1.end();
        await c2.end();
      }
    });
  });

  it("undo while the reply is in flight (sending) = busy, nothing changed; after it settles, undo works", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await toPending(r.actionId);
    await reply(r.actionId, r.sendId, "sending");
    const snap = await snapshot();
    expect(await undo(ownerId, r.actionId)).toMatchObject({ status: "busy", reason: "reply_in_flight", restored: [] });
    expect(await snapshot()).toEqual(snap);
    await reply(r.actionId, r.sendId, "sent", randomUUID());
    expect((await undo(ownerId, r.actionId)).status).toBe("undone");
  });

  it("duplicate webhook during an in-flight send: recovery leaves it `sending` and undo stays busy; after the lease it settles", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await toPending(r.actionId);
    await reply(r.actionId, r.sendId, "sending");
    const snap = await snapshot();
    // Duplicate webhook -> recovery runs immediately: inside the lease it changes nothing.
    const early = await recover(r.actionId);
    expect(early).toMatchObject({ replyState: "sending", inFlight: true });
    expect(early.retryAfterSeconds).toBeGreaterThan(100);
    expect(early.retryAfterSeconds).toBeLessThanOrEqual(120);
    const row = (await db.query(`select reply_state, reply_message_id from public.routing_v2_phone_actions where id = $1`, [r.actionId])).rows[0];
    expect(row).toEqual({ reply_state: "sending", reply_message_id: null });
    expect(await undo(ownerId, r.actionId)).toMatchObject({ status: "busy", reason: "reply_in_flight" });
    expect(await snapshot()).toEqual(snap);
    // The settler does not pick it up inside the lease either.
    const feed = async () =>
      (await asService(async () => (await db.query(`select action_id from public.fn_routing_v2_phone_action_unsettled_replies(0, 50)`)).rows)).map((x) => x.action_id);
    expect(await feed()).not.toContain(r.actionId);
    // After the lease: no message for the send id -> unknown; undo then works.
    await expireSendLease(r.actionId);
    expect(await feed()).toContain(r.actionId);
    expect(await recover(r.actionId)).toMatchObject({ replyState: "unknown" });
    expect((await undo(ownerId, r.actionId)).status).toBe("undone");
  });

  it("after the lease, a reply that did go out is recorded sent; undo then still restores (properties only)", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await toPending(r.actionId);
    await reply(r.actionId, r.sendId, "sending");
    await db.query(
      `insert into public.messages (org_id, property_id, conversation_id, channel, direction, body, to_address, idempotency_key, status, external_id) values ($1, $2, $3, 'sms', 'outbound', $4, $5, $6, 'sent', 'SM9')`,
      [orgId, ids.p1, ids.conv, APPROVED_REPLY_TEXTS.wrong_number, X, r.sendId],
    );
    expect(await recover(r.actionId)).toMatchObject({ replyState: "sending", inFlight: true }); // still in the lease
    await expireSendLease(r.actionId);
    expect(await recover(r.actionId)).toMatchObject({ replyState: "sent" });
    const u = await undo(ownerId, r.actionId);
    expect(u.status).not.toBe("busy");
  });

  it("undo first: the not-yet-started reply is skipped and pending -> sending is refused", async () => {
    await setFlags(ON);
    const r = await applyAll();
    await toPending(r.actionId);
    expect((await undo(ownerId, r.actionId)).status).toBe("undone");
    expect(await reply(r.actionId, r.sendId, "sending")).toMatchObject({ ok: false, replyState: "skipped" });
  });

});

describe("self-sweep", () => {
  it("(b) lock order is the same in apply_all and undo: phone -> contacts -> suppressions -> property advisory -> properties -> enrollments", () => {
    const sql = readFileSync(path.join(__dirname, "20261030190000_routing_v2_wrong_number_all.sql"), "utf8");
    const body = (name: string) => {
      const start = sql.indexOf(`create or replace function public.${name}(`);
      return sql.slice(start, sql.indexOf("\n$$;", start));
    };
    const order = (b: string, markers: string[]) => markers.map((m) => b.indexOf(m));
    const BAR = "pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1'";
    const apply = order(body("fn_routing_v2_phone_action_apply_all"), [
      BAR, "routing_v2_phone_lock(", "from public.contacts c\n  where c.id = any(v_contacts)", "from public.sms_phone_suppressions sp",
      "hashtext('routing_v2:'", "from public.properties p where p.id = any(v_ids) order by p.id for update", "update public.sequence_enrollments e",
    ]);
    // Undo: the wrapper takes the phone lock then calls the core (contacts -> suppressions -> ...).
    const undoWrap = order(body("fn_undo_routing_v2_phone_action"), [BAR, "routing_v2_phone_lock(", "routing_v2_phone_action_undo_core("]);
    const fenceWrap = order(body("fn_routing_v2_phone_action_release_fence"), [BAR, "routing_v2_phone_lock(", "update public.properties"]);
    expect(body("fn_routing_v2_phone_action_release_fence")).not.toContain("routing_v2_phone_action_undo_core(");
    // Nothing writes properties/contacts/enrollments before the barrier.
    for (const fn of ["fn_routing_v2_phone_action_apply_all", "fn_undo_routing_v2_phone_action", "fn_routing_v2_phone_action_release_fence"]) {
      const b = body(fn);
      const barAt = b.indexOf(BAR);
      for (const w of ["update public.properties", "update public.sequence_enrollments", "from public.contacts", "for update"]) {
        const at = b.indexOf(w);
        if (at >= 0) expect(at, `${fn}: ${w}`).toBeGreaterThan(barAt);
      }
    }
    const replyWrap = order(body("fn_routing_v2_phone_action_reply"), ["routing_v2_phone_lock(", "for update"]);
    const undoOrder = order(body("routing_v2_phone_action_undo_core"), [
      "order by c.id for share", "lock table public.sms_phone_suppressions",
      "hashtext('routing_v2:'", "for update of p", "from public.sequence_enrollments e",
    ]);
    expect(body("routing_v2_phone_action_undo_core")).not.toContain("routing_v2_phone_lock(");
    for (const seq of [apply, undoOrder, undoWrap, fenceWrap, replyWrap]) {
      expect(seq.every((i) => i > 0)).toBe(true);
      expect([...seq].sort((a, b) => a - b)).toEqual(seq);
    }
  });

  it("(c) FKs: org/property/message cascade (org delete is gated by core tables), users set null; deletes cascade", async () => {
    await setFlags(ON);
    const r = await applyAll();
    expect(r.status).toBe("applied");
    const fks = (await db.query(`
      select conrelid::regclass::text t, confrelid::regclass::text ref, confdeltype
      from pg_constraint where contype = 'f' and conrelid in ('public.routing_v2_phone_actions'::regclass, 'public.routing_v2_phone_action_properties'::regclass)
      order by 1, 2`)).rows;
    const cascade = fks.filter((f) => f.ref !== "auth.users");
    expect(cascade.every((f) => f.confdeltype === "c")).toBe(true);
    expect(cascade.map((f) => `${f.t}->${f.ref}`)).toEqual(expect.arrayContaining([
      "routing_v2_phone_actions->organizations", "routing_v2_phone_actions->properties", "routing_v2_phone_actions->messages",
      "routing_v2_phone_action_properties->organizations", "routing_v2_phone_action_properties->properties", "routing_v2_phone_action_properties->routing_v2_phone_actions",
    ]));
    expect(fks.filter((f) => f.ref === "auth.users").every((f) => f.confdeltype === "n")).toBe(true);
    // An org that still has properties/messages cannot be deleted (core no-action FKs); PR-G adds no blocker.
    await db.query("savepoint orgdel");
    await expect(db.query(`delete from public.organizations where id = $1`, [orgId])).rejects.toThrow(/foreign key/);
    await db.query("rollback to savepoint orgdel");
    const blockers = (await db.query(`
      select conrelid::regclass::text t from pg_constraint
      where contype = 'f' and confrelid = 'public.organizations'::regclass and confdeltype not in ('c', 'n')
        and conrelid::regclass::text like 'routing_v2%'`)).rows;
    expect(blockers).toEqual([]);
    // Deleting the source inbound removes the action and every per-property row with it.
    await db.query("set local session_replication_role = replica");
    await db.query(`delete from public.routing_v2_shadow_decisions where inbound_message_id = $1`, [inbound]);
    await db.query("set local session_replication_role = origin");
    await db.query(`delete from public.messages where id = $1`, [inbound]);
    expect(Number((await db.query(`select count(*) from public.routing_v2_phone_actions where id = $1`, [r.actionId])).rows[0].count)).toBe(0);
    expect(Number((await db.query(`select count(*) from public.routing_v2_phone_action_properties where action_id = $1`, [r.actionId])).rows[0].count)).toBe(0);
  });

  it("(d) NOT NULL + CHECK on every status column", async () => {
    await setFlags(ON);
    const r = await applyAll();
    for (const [sql, args] of [
      [`update public.routing_v2_phone_actions set status = 'bogus' where id = $1`, [r.actionId]],
      [`update public.routing_v2_phone_actions set status = null where id = $1`, [r.actionId]],
      [`update public.routing_v2_phone_actions set reply_state = 'bogus' where id = $1`, [r.actionId]],
      [`update public.routing_v2_phone_actions set reply_state = null where id = $1`, [r.actionId]],
      [`update public.routing_v2_phone_actions set status = 'undone' where id = $1`, [r.actionId]], // undone needs undone_at
      [`update public.routing_v2_phone_actions set fence_at = null where id = $1`, [r.actionId]], // awaiting_fence needs fence_at
      [`update public.routing_v2_phone_actions set reply_state = 'sending', sending_at = null where id = $1`, [r.actionId]], // sending needs sending_at
      [`update public.routing_v2_phone_action_properties set outcome = 'bogus' where action_id = $1`, [r.actionId]],
      [`update public.routing_v2_phone_action_properties set outcome = 'skipped' where action_id = $1 and outcome = 'applied'`, [r.actionId]],
      [`update public.routing_v2_phone_action_properties set paused_at = null where action_id = $1 and cardinality(paused_enrollment_ids) > 0`, [r.actionId]],
    ] as Array<[string, unknown[]]>) {
      await db.query("savepoint chk");
      await expect(db.query(sql, args), sql).rejects.toThrow(/violates/);
      await db.query("rollback to savepoint chk");
    }
  });

  it("(e) indexes exist for every lookup and the settler", async () => {
    const idx = (await db.query(`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('routing_v2_phone_actions', 'routing_v2_phone_action_properties', 'messages', 'routing_v2_shadow_decisions')`)).rows;
    const names = idx.map((i) => i.indexname);
    expect(names).toEqual(expect.arrayContaining([
      "routing_v2_phone_actions_inbound_uidx", "routing_v2_phone_actions_send_id_uidx", "routing_v2_phone_actions_unsettled_idx",
      "routing_v2_phone_action_properties_uidx", "routing_v2_phone_action_properties_property_idx",
      "messages_outbound_sms_idempotency_idx", "idx_messages_created", "routing_v2_shadow_decisions_inbound_uidx",
    ]));
    expect(idx.find((i) => i.indexname === "routing_v2_phone_actions_unsettled_idx")?.indexdef).toMatch(/reply_state.*awaiting_fence.*pending.*sending/);
  });

  it("(f) grants, RLS and search_path", async () => {
    const can = async (role: string, fn: string) =>
      (await db.query(`select has_function_privilege($1, $2, 'EXECUTE') ok`, [role, fn])).rows[0].ok;
    const serviceOnly = [
      "public.fn_routing_v2_phone_action_apply_all(uuid, text, text, jsonb, bigint)",
      "public.fn_routing_v2_phone_action_reply(uuid, uuid, text, uuid, text)",
      "public.fn_routing_v2_phone_action_recover_reply(uuid)",
      "public.fn_routing_v2_phone_action_unsettled_replies(integer, integer)",
      "public.fn_routing_v2_phone_action_release_fence(uuid)",
      "public.fn_routing_v2_phone_action_send_allowed(uuid)",
    ];
    for (const fn of serviceOnly) {
      expect(await can("service_role", fn), fn).toBe(true);
      expect(await can("authenticated", fn), fn).toBe(false);
      expect(await can("anon", fn), fn).toBe(false);
    }
    expect(await can("authenticated", "public.fn_undo_routing_v2_phone_action(uuid)")).toBe(true);
    expect(await can("anon", "public.fn_undo_routing_v2_phone_action(uuid)")).toBe(false);
    for (const fn of ["public.routing_v2_phone_lock(uuid, text)", "public.routing_v2_clear_pause_token()", "public.routing_v2_phone_action_undo_core(uuid, uuid)"]) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(await can(role, fn), `${role} ${fn}`).toBe(false);
    }
    const tables = (await db.query(`select relname, relrowsecurity from pg_class where relname in ('routing_v2_phone_actions', 'routing_v2_phone_action_properties')`)).rows;
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
    for (const role of ["authenticated", "service_role"]) {
      for (const t of ["public.routing_v2_phone_actions", "public.routing_v2_phone_action_properties"]) {
        const priv = (await db.query(`select has_table_privilege($1, $2, 'INSERT') i, has_table_privilege($1, $2, 'UPDATE') u, has_table_privilege($1, $2, 'DELETE') d, has_table_privilege($1, $2, 'SELECT') s`, [role, t])).rows[0];
        expect(priv, `${role} ${t}`).toEqual({ i: false, u: false, d: false, s: true });
      }
    }
    const definers = (await db.query(`
      select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proname like '%routing_v2_phone%' or p.proname = 'routing_v2_clear_pause_token')`)).rows;
    expect(definers.length).toBeGreaterThanOrEqual(11);
    for (const d of definers) expect(d.cfg, d.proname).toMatch(/search_path=public, pg_temp/);
  });

  it("(g) rollback removes every object, including the enrollment token column and trigger", async () => {
    await db.query(ROLLBACK);
    const left = (await db.query(`select to_regclass('public.routing_v2_phone_actions') a, to_regclass('public.routing_v2_phone_action_properties') b`)).rows[0];
    expect(left).toEqual({ a: null, b: null });
    const fns = (await db.query(`select count(*) from pg_proc where proname like '%routing_v2_phone%' or proname = 'routing_v2_clear_pause_token'`)).rows[0].count;
    expect(Number(fns)).toBe(0);
    const col = (await db.query(`select count(*) from information_schema.columns where table_name = 'sequence_enrollments' and column_name = 'routing_v2_pause_token'`)).rows[0].count;
    expect(Number(col)).toBe(0);
    const trg = (await db.query(`select count(*) from pg_trigger where tgname = 'trg_sequence_enrollments_routing_v2_pause_token'`)).rows[0].count;
    expect(Number(trg)).toBe(0);
  });
});
