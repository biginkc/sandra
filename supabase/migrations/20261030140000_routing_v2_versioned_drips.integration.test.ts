import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ROUTING_V2_DRIPS } from "@/lib/sequences/routing-v2/drip-spec";
import { isV2Eligible, parseRoutingV2Flags } from "@/lib/sms-classification/routing-v2/flags";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * Routing v2 PR-C (20261030140000): versioned drip seed + route_reply_transition (§14) +
 * send-time checks. Local-only; each test runs in a rolled-back transaction except the
 * concurrency test, which commits and cleans up its own org.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION_RAW = readFileSync(path.join(__dirname, "20261030140000_routing_v2_versioned_drips.sql"), "utf8");
const MIGRATION = strip(MIGRATION_RAW);
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "../rollbacks/20261030140000_routing_v2_versioned_drips.sql"), "utf8"),
);
const DAY = 1440;
const FLAGS_ON = { questions_live: true, drips: true, replies: true, alert_on_time_only: true, canary_property_ids: [] as string[], canary_percent: 100 };

const db = new Client({ connectionString: url });
beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

type Ctx = { org: string; contact: string; property: string; bookSrc: string; listedSrc: string; legacyEnrollment: string };

async function seedOrg(c: Client): Promise<Ctx> {
  const org = randomUUID();
  await c.query("insert into public.organizations (id, name) values ($1, $2)", [org, `rv2-${org}`]);
  const q = async (sql: string, args: unknown[]) => (await c.query(sql, args)).rows[0];
  const contact = (await q(
    `insert into public.contacts (org_id, first_name, last_name, phone_1) values ($1,'Pat',$2,'+18165550100') returning id`,
    [org, randomUUID()],
  )).id;
  const property = (await q(
    `insert into public.properties (org_id, address, state, status, homeowner_contact_id) values ($1,'1 Test St','MO','new_lead',$2) returning id`,
    [org, contact],
  )).id;
  const bookSrc = (await q(`insert into public.sequences (org_id, name, active) values ($1,'Book appointment',true) returning id`, [org])).id;
  // Existing Book appointment: 6 old steps (days 1,2,3,4,5,6) then days 98, 188, 374.
  const bookDays = [1, 2, 3, 4, 5, 6, 98, 188, 374];
  for (let i = 0; i < bookDays.length; i++) {
    await c.query(
      `insert into public.sequence_steps (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body)
       values ($1,$2,$3,'send_sms',$4)`,
      [bookSrc, i, (bookDays[i]! - (bookDays[i - 1] ?? 0)) * DAY, `old book ${i}`],
    );
  }
  const listedSrc = (await q(`insert into public.sequences (org_id, name, active) values ($1,'Listed, not selling',true) returning id`, [org])).id;
  const listedDays = [0, 7, 30];
  for (let i = 0; i < listedDays.length; i++) {
    await c.query(
      `insert into public.sequence_steps (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body)
       values ($1,$2,$3,'send_sms',$4)`,
      [listedSrc, i, (listedDays[i]! - (listedDays[i - 1] ?? 0)) * DAY, `old listed ${i}`],
    );
  }
  await c.query(
    `insert into public.ai_responder_configs (org_id, system_prompt, nurture_drip_hot_book_appointment_sequence_id) values ($1,'x',$2)`,
    [org, bookSrc],
  );
  const legacyEnrollment = (await q(
    `insert into public.sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at)
     values ($1,$2,$3,$4,'active',2, now() + interval '1 day') returning id`,
    [org, bookSrc, property, contact],
  )).id;
  return { org, contact, property, bookSrc, listedSrc, legacyEnrollment };
}

const setFlags = (c: Client, org: string, flags: Record<string, unknown>) =>
  c.query(`update public.ai_responder_configs set routing_v2_flags = $2::jsonb where org_id = $1`, [org, JSON.stringify(flags)]);
// Test inbound times are shifted 400 days into the past (order preserved) so they are always
// older than the claims / updates a test makes with now() (the final advance treats a seller
// message newer than the claim as a reply that wins).
const PAST_SHIFT_MS = 400 * 86_400_000;
const inbound = async (c: Client, ctx: Ctx, at: string) =>
  (await c.query(
    `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, created_at)
     values ($1,$2,$3,'inbound','sms','hi',$4) returning id`,
    [ctx.org, ctx.property, ctx.contact, new Date(Date.parse(at) - PAST_SHIFT_MS).toISOString()],
  )).rows[0].id as string;
const transition = async (c: Client, inboundId: string, property: string, decision: Record<string, unknown>) =>
  (await c.query(`select public.route_reply_transition($1,$2,$3::jsonb) as r`, [inboundId, property, JSON.stringify(decision)])).rows[0].r;
const enrollments = async (c: Client, property: string) =>
  (await c.query(
    `select e.id, e.status, e.ended_reason, e.routing_v2_engine, s.routing_v2_key
     from public.sequence_enrollments e join public.sequences s on s.id = e.sequence_id
     where e.property_id = $1 order by e.enrolled_at, e.id`,
    [property],
  )).rows;
const steps = async (c: Client, org: string, key: string) =>
  (await c.query(
    `select st.step_index, st.delay_after_previous_minutes as delay, st.template_body as body, st.slot_window
     from public.sequence_steps st join public.sequences s on s.id = st.sequence_id
     where s.org_id = $1 and s.routing_v2_key = $2 order by st.step_index`,
    [org, key],
  )).rows;
const snapshotLegacy = async (c: Client, org: string) =>
  (await c.query(
    `select jsonb_build_object(
       'seq', (select jsonb_agg(to_jsonb(s) - 'routing_v2_key' - 'routing_v2_version' - 'routing_v2_then_key' order by s.id) from public.sequences s where s.org_id = $1 and (to_jsonb(s)->>'routing_v2_key') is null),
       'steps', (select jsonb_agg(to_jsonb(st) - 'slot_window' order by st.id) from public.sequence_steps st join public.sequences s on s.id = st.sequence_id where s.org_id = $1 and (to_jsonb(s)->>'routing_v2_key') is null),
       'enr', (select jsonb_agg(to_jsonb(e) - 'routing_v2_engine' - 'ended_reason' - 'retired_by_inbound_id' - 'routing_v2_inbound_id' order by e.id) from public.sequence_enrollments e where e.org_id = $1)
     ) as j`,
    [org],
  )).rows[0].j;

describe("routing v2 versioned drips (rolled back per test)", () => {
  let ctx: Ctx;
  let before: unknown;
  beforeEach(async () => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    ctx = await seedOrg(db);
    await db.query("set local session_replication_role = origin");
    // Re-apply on top of whatever the stack already has: seeds this test org.
    await db.query(ROLLBACK.replace(/raise exception 'routing v2 enrollments exist[^']*';/, "null;"));
    before = await snapshotLegacy(db, ctx.org);
    await db.query(MIGRATION);
  });
  afterEach(async () => {
    await db.query("rollback");
  });

  it("existing drips, steps and enrollments are byte-identical after the migration", async () => {
    expect(await snapshotLegacy(db, ctx.org)).toEqual(before);
  });

  it("re-running the migration is a no-op (one version per key)", async () => {
    await db.query(MIGRATION);
    const r = await db.query(
      `select routing_v2_key, count(*)::int as n, bool_or(active) as any_active from public.sequences where org_id = $1 and routing_v2_key is not null group by 1 order by 1`,
      [ctx.org],
    );
    expect(r.rows).toEqual(
      ["book_appointment", "listed_not_selling", "price_too_high", "said_theyd_call", "vacant_land"].map((k) => ({
        routing_v2_key: k,
        n: 1,
        any_active: false,
      })),
    );
  });

  it("new drips carry the spec texts, days and windows", async () => {
    for (const key of ["price_too_high", "vacant_land", "said_theyd_call"] as const) {
      const spec = ROUTING_V2_DRIPS[key].steps;
      expect(await steps(db, ctx.org, key)).toEqual(
        spec.map((s, i) => ({ step_index: i, delay: (s.day - (spec[i - 1]?.day ?? 0)) * DAY, body: s.body, slot_window: s.slotWindow })),
      );
    }
  });

  it("Book appointment v2 = 6 new steps then the existing later steps on their original days", async () => {
    const rows = await steps(db, ctx.org, "book_appointment");
    expect(rows.map((r) => r.body)).toEqual([
      ...ROUTING_V2_DRIPS.book_appointment.steps.map((s) => s.body),
      "old book 6",
      "old book 7",
      "old book 8",
    ]);
    let cum = 0;
    const days = rows.map((r) => (cum += r.delay) / DAY);
    expect(days).toEqual([1, 2, 4, 5, 7, 8, 98, 188, 374]);
  });

  it("Listed v2 = every existing step + the new day-2 step, days preserved", async () => {
    const rows = await steps(db, ctx.org, "listed_not_selling");
    expect(rows.map((r) => r.body)).toEqual(["old listed 0", ROUTING_V2_DRIPS.listed_not_selling.steps[0]!.body, "old listed 1", "old listed 2"]);
    let cum = 0;
    expect(rows.map((r) => (cum += r.delay) / DAY)).toEqual([0, 2, 7, 30]);
  });

  it("flags off: the transition records flag_off and changes nothing", async () => {
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "price_too_high" });
    expect(r.outcome).toBe("flag_off");
    expect(await snapshotLegacy(db, ctx.org)).toEqual(before);
  });

  it("flags on: retires active AND paused enrollments, enrolls the new version; repeat is idempotent", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    // One live (active/paused) drip per property is enforced (idx_enrollments_one_live_per_property):
    // first reply retires the ACTIVE legacy row; the v2 row is then paused and the next reply retires it.
    const id0 = await inbound(db, ctx, "2026-10-30T14:00:00Z");
    const r0 = await transition(db, id0, ctx.property, { sequence_key: "price_too_high" });
    expect(r0.retired_enrollment_ids).toEqual([ctx.legacyEnrollment]);
    await db.query(`update public.sequence_enrollments set status = 'paused', pause_reason = 'inbound_reply' where id = $1`, [r0.new_enrollment_id]);
    const paused = r0.new_enrollment_id;
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "book_appointment" });
    expect(r.outcome).toBe("applied");
    expect(r.retired_enrollment_ids).toEqual([paused]);
    const rows = await enrollments(db, ctx.property);
    expect(rows.filter((e) => e.status === "active")).toEqual([
      expect.objectContaining({ routing_v2_engine: "v2", routing_v2_key: "book_appointment" }),
    ]);
    expect(rows.filter((e) => e.ended_reason === "rerouted")).toHaveLength(2);

    const again = await transition(db, id, ctx.property, { sequence_key: "price_too_high" });
    expect(again.replayed).toBe(true);
    expect(again.new_enrollment_id).toBe(r.new_enrollment_id);
    expect((await enrollments(db, ctx.property)).filter((e) => e.status === "active")).toHaveLength(1);
  });

  it("latest reply wins: an older inbound processed after a newer one is superseded", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const older = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const newer = await inbound(db, ctx, "2026-10-30T15:05:00Z");
    expect((await transition(db, newer, ctx.property, { sequence_key: "vacant_land" })).outcome).toBe("applied");
    expect((await transition(db, older, ctx.property, { sequence_key: "price_too_high" })).outcome).toBe("superseded");
    const active = (await enrollments(db, ctx.property)).filter((e) => e.status === "active");
    expect(active.map((e) => e.routing_v2_key)).toEqual(["vacant_land"]);
  });

  it("a newer reply cancels the older reply's pending intents; delivery re-check refuses stale rows", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r1 = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    await transition(db, r1, ctx.property, { outbox: [{ kind: "reply", payload: { t: 1 } }] });
    const firstRow = (await db.query(`select id from public.routing_v2_outbox where inbound_message_id = $1`, [r1])).rows[0].id;
    const r2 = await inbound(db, ctx, "2026-10-30T15:01:00Z");
    const t2 = await transition(db, r2, ctx.property, { outbox: [{ kind: "reply", payload: { t: 2 } }] });
    expect(t2.cancelled_outbox_ids).toEqual([firstRow]);
    expect((await db.query(`select public.routing_v2_claim_outbox($1) as r`, [firstRow])).rows[0].r).toBe("not_pending");
    const second = (await db.query(`select id from public.routing_v2_outbox where inbound_message_id = $1`, [r2])).rows[0].id;
    expect((await db.query(`select public.routing_v2_claim_outbox($1) as r`, [second])).rows[0].r).toBe("ok");
  });

  it("human takeover after the inbound: drips retired, nothing enrolled, no auto reply, alert kept", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    await db.query(`update public.properties set last_person_takeover_at = (timestamptz '2026-10-30T15:02:00Z' - interval '400 days') where id = $1`, [ctx.property]);
    const r = await transition(db, id, ctx.property, {
      sequence_key: "book_appointment",
      outbox: [{ kind: "reply", payload: {} }, { kind: "alert", payload: {} }],
    });
    expect(r.outcome).toBe("takeover_blocked");
    expect(r.new_enrollment_id).toBeNull();
    expect((await enrollments(db, ctx.property)).filter((e) => e.status === "active")).toHaveLength(0);
    const kinds = (await db.query(`select kind from public.routing_v2_outbox where inbound_message_id = $1`, [id])).rows.map((x) => x.kind);
    expect(kinds).toEqual(["alert"]);
  });

  it("a takeover after a reply was queued cancels it before delivery", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    await transition(db, id, ctx.property, { outbox: [{ kind: "reply", payload: {} }] });
    const row = (await db.query(`select id from public.routing_v2_outbox where inbound_message_id = $1`, [id])).rows[0].id;
    await db.query(`update public.properties set last_person_takeover_at = now() + interval '1 day' where id = $1`, [ctx.property]);
    // PR-C's claim refuses it ("human_takeover"); once PR-F's takeover fence (20261030230000)
    // is on the stack the takeover itself already cancelled it ("not_pending"). Same end state.
    expect(["human_takeover", "not_pending"]).toContain((await db.query(`select public.routing_v2_claim_outbox($1) as r`, [row])).rows[0].r);
    expect((await db.query(`select status, cancel_reason from public.routing_v2_outbox where id = $1`, [row])).rows[0]).toEqual({ status: "cancelled", cancel_reason: "human_takeover" });
  });

  it("suppressed seller: drips retired, nothing enrolled", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    await db.query(`insert into public.sms_phone_suppressions (org_id, phone_e164, source) values ($1,'+18165550100','carrier_stop')`, [ctx.org]);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "book_appointment" });
    expect(r.outcome).toBe("suppressed");
    expect((await enrollments(db, ctx.property)).filter((e) => e.status === "active")).toHaveLength(0);
  });

  it("send-time check: flag flipped off stops a v2 enrollment; legacy enrollments always pass untouched", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "said_theyd_call" });
    expect((await db.query(`select public.routing_v2_enrollment_send_check($1) as r`, [r.new_enrollment_id])).rows[0].r).toBe("ok");
    await setFlags(db, ctx.org, { ...FLAGS_ON, drips: false });
    expect((await db.query(`select public.routing_v2_enrollment_send_check($1) as r`, [r.new_enrollment_id])).rows[0].r).toBe("flag_off");
    const e = (await db.query(`select status, ended_reason from public.sequence_enrollments where id = $1`, [r.new_enrollment_id])).rows[0];
    expect(e).toEqual({ status: "completed", ended_reason: "flag_off" });

    // Legacy row (flags irrelevant): 'ok', and nothing written.
    const snap = await snapshotLegacy(db, ctx.org);
    expect((await db.query(`select public.routing_v2_enrollment_send_check($1) as r`, [ctx.legacyEnrollment])).rows[0].r).toBe("ok");
    expect(await snapshotLegacy(db, ctx.org)).toEqual(snap);
  });

  it("send-time check: takeover after enrollment pauses it", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "price_too_high" });
    await db.query(`update public.properties set last_person_takeover_at = now() + interval '1 minute' where id = $1`, [ctx.property]);
    expect((await db.query(`select public.routing_v2_enrollment_send_check($1) as r`, [r.new_enrollment_id])).rows[0].r).toBe("person_took_over");
  });

  it("canary: ineligible property (percent 0, not listed) is flag_off", async () => {
    await setFlags(db, ctx.org, { ...FLAGS_ON, canary_percent: 0 });
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    expect((await transition(db, id, ctx.property, { sequence_key: "vacant_land" })).outcome).toBe("flag_off");
    await setFlags(db, ctx.org, { ...FLAGS_ON, canary_percent: 0, canary_property_ids: [ctx.property] });
    const id2 = await inbound(db, ctx, "2026-10-30T15:01:00Z");
    expect((await transition(db, id2, ctx.property, { sequence_key: "vacant_land" })).outcome).toBe("applied");
  });

  it("no v2 drip names a next drip (auto handoff disabled); the chain function is an inert no-op", async () => {
    const r0 = await db.query(`select count(*)::int as n from public.sequences where org_id = $1 and routing_v2_then_key is not null`, [ctx.org]);
    expect(r0.rows[0].n).toBe(0);
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "said_theyd_call" });
    await db.query(`update public.sequence_enrollments set status = 'completed', completed_at = now(), next_run_at = null where id = $1`, [r.new_enrollment_id]);
    expect((await db.query(`select public.routing_v2_chain_after_completion($1) as r`, [r.new_enrollment_id])).rows[0].r).toBeNull();
    expect((await enrollments(db, ctx.property)).filter((e) => e.status === "active")).toHaveLength(0);
    // A next drip can't be configured outside a migration.
    await db.query("set local routing_v2.allow_drip_edit = ''");
    const v2 = (await db.query(`select id from public.sequences where org_id = $1 and routing_v2_key = 'said_theyd_call'`, [ctx.org])).rows[0].id;
    await db.query("savepoint t");
    await expect(db.query(`update public.sequences set routing_v2_then_key = 'book_appointment' where id = $1`, [v2])).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint t");
  });
});

const stepRun = async (c: Client, enrollmentId: string) =>
  (await c.query(
    `insert into public.sequence_step_runs (enrollment_id, step_id, scheduled_for, attempt_outcome)
     select e.id, st.id, now(), 'not_attempted'
     from public.sequence_enrollments e
     join public.sequence_steps st on st.sequence_id = e.sequence_id and st.step_index = e.current_step_index
     where e.id = $1 returning id, step_id`,
    [enrollmentId],
  )).rows[0] as { id: string; step_id: string };
const authorize = async (c: Client, ctx: Ctx, enrollmentId: string, run: { id: string; step_id: string }, messageId: string = randomUUID()) =>
  (await c.query(
    `select * from public.authorize_sequence_provider_attempt($1,$2,$3,$4,$5,'+18165550100',$6)`,
    [enrollmentId, run.step_id, run.id, ctx.contact, ctx.property, messageId],
  )).rows[0] as { authorized: boolean; reason: string };
// A claim for the enrollment's current step with recorded provider acceptance (R7).
const acceptedClaim = async (c: Client, enrollmentId: string) => {
  const run = await stepRun(c, enrollmentId);
  const ok = (await c.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [enrollmentId, run.id])).rows[0].r;
  if (ok !== "ok") throw new Error(`claim refused: ${ok}`);
  await c.query(`select public.routing_v2_record_provider_outcome($1, 'accepted', null)`, [run.id]);
  return run;
};
const lockDnc = (c: Client, property: string) =>
  c.query(`update public.properties set is_dnc_locked = true where id = $1`, [property]);

describe("routing v2 PR-C review fixes (rolled back per test, real triggers)", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    ctx = await seedOrg(db);
    await db.query("set local session_replication_role = origin");
    await db.query(ROLLBACK.replace(/raise exception 'routing v2 enrollments exist[^']*';/, "null;"));
    await db.query(MIGRATION);
    // The rollback opted this transaction into drip edits; tests run with the guard armed.
    await db.query("set local routing_v2.allow_drip_edit = ''");
  });
  afterEach(async () => {
    await db.query("rollback");
  });

  it("the real DNC enrollment guard is installed on sequence_enrollments", async () => {
    const r = await db.query(
      `select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.sequence_enrollments'::regclass and p.proname = 'guard_locked_property_sequence_enrollment' and not t.tgisinternal`,
    );
    expect(r.rowCount).toBe(1);
  });

  it("DNC-locked property: the transition opts enrollments out (the one allowed change) and records suppressed", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    // Lock after the enrollments exist, with the lock cascade off, so active/paused rows remain.
    await db.query("set local session_replication_role = replica");
    await lockDnc(db, ctx.property);
    await db.query("set local session_replication_role = origin");
    const r = await transition(db, id, ctx.property, {
      sequence_key: "book_appointment",
      outbox: [{ kind: "reply", payload: {} }, { kind: "alert", payload: {} }],
    });
    expect(r.outcome).toBe("suppressed");
    expect(r.new_enrollment_id).toBeNull();
    expect(r.retired_enrollment_ids).toEqual([ctx.legacyEnrollment]);
    const rows = (await db.query(
      `select status, pause_reason, ended_reason, next_run_at from public.sequence_enrollments where property_id = $1 order by id`,
      [ctx.property],
    )).rows;
    expect(rows).toHaveLength(1);
    for (const row of rows) expect(row).toEqual({ status: "opted_out", pause_reason: "dnc", ended_reason: null, next_run_at: null });
    const kinds = (await db.query(`select kind from public.routing_v2_outbox where inbound_message_id = $1`, [id])).rows.map((x) => x.kind);
    expect(kinds).toEqual(["alert"]);
  });

  it("DNC-locked property: the old completed/rerouted write really is rejected by the trigger (guards the fix)", async () => {
    await db.query("set local session_replication_role = replica");
    await lockDnc(db, ctx.property);
    await db.query("set local session_replication_role = origin");
    await expect(
      db.query(
        `update public.sequence_enrollments set status = 'completed', completed_at = now(), next_run_at = null, ended_reason = 'rerouted' where id = $1`,
        [ctx.legacyEnrollment],
      ),
    ).rejects.toThrow(/DNC_LOCKED/);
  });

  it("DNC-locked property: send check and check-and-claim stop a v2 enrollment with the compliance opt-out", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "price_too_high" });
    const run = await stepRun(db, r.new_enrollment_id);
    await db.query("set local session_replication_role = replica");
    await lockDnc(db, ctx.property);
    await db.query("set local session_replication_role = origin");
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [r.new_enrollment_id, run.id])).rows[0].r).toBe("suppressed");
    expect((await db.query(`select status, pause_reason from public.sequence_enrollments where id = $1`, [r.new_enrollment_id])).rows[0])
      .toEqual({ status: "opted_out", pause_reason: "dnc" });
    // And with the flag flipped off (the old flag_off write would also hit the lock).
    await setFlags(db, ctx.org, { ...FLAGS_ON, drips: false });
    expect((await db.query(`select public.routing_v2_enrollment_send_check($1) as r`, [r.new_enrollment_id])).rows[0].r).toBe("not_active");
  });

  it("DNC-locked + flag off: send check opts out instead of raising", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "vacant_land" });
    await setFlags(db, ctx.org, { ...FLAGS_ON, drips: false });
    await db.query("set local session_replication_role = replica");
    await lockDnc(db, ctx.property);
    await db.query("set local session_replication_role = origin");
    expect((await db.query(`select public.routing_v2_enrollment_send_check($1) as r`, [r.new_enrollment_id])).rows[0].r).toBe("suppressed");
  });

  it("check-and-claim: ok records an open claim; a later reply cancels it and the provider fence refuses", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const first = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, first, ctx.property, { sequence_key: "price_too_high" });
    const run = await stepRun(db, r.new_enrollment_id);
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [r.new_enrollment_id, run.id])).rows[0].r).toBe("ok");
    const claim = (await db.query(`select id, status from public.routing_v2_drip_send_claims where step_run_id = $1`, [run.id])).rows[0];
    expect(claim.status).toBe("open");

    const reply = await inbound(db, ctx, "2026-10-30T15:10:00Z");
    const t = await transition(db, reply, ctx.property, { sequence_key: "vacant_land" });
    expect(t.cancelled_drip_claim_ids).toEqual([claim.id]);
    expect((await db.query(`select status from public.routing_v2_drip_send_claims where id = $1`, [claim.id])).rows[0].status).toBe("cancelled");
    const fence = await authorize(db, ctx, r.new_enrollment_id, run);
    expect(fence.authorized).toBe(false);
    // Refused by the v2 claim gate (claim cancelled) before the enrollment check (R6).
    expect(fence.reason).toMatch(/routing v2 drip claim is not open|no longer active/);
    // Re-claiming the retired enrollment refuses.
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [r.new_enrollment_id, run.id])).rows[0].r).toBe("not_active");
  });

  it("only routing v2 can enroll into a v2 drip: manual insert, change-drip and clearing the engine are refused", async () => {
    const v2 = (await db.query(`select id from public.sequences where org_id = $1 and routing_v2_key = 'price_too_high'`, [ctx.org])).rows[0].id;
    await db.query("savepoint s");
    await db.query(`update public.sequence_enrollments set status = 'completed', completed_at = now(), next_run_at = null where id = $1`, [ctx.legacyEnrollment]);
    await expect(db.query(
      `insert into public.sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at)
       values ($1,$2,$3,$4,'active',0, now())`,
      [ctx.org, v2, ctx.property, ctx.contact],
    )).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint s");
    await expect(db.query(`update public.sequence_enrollments set sequence_id = $2 where id = $1`, [ctx.legacyEnrollment, v2]))
      .rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint s");
    // Clearing routing_v2_engine on a real v2 enrollment is refused too.
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "price_too_high" });
    await db.query("savepoint s2");
    await expect(db.query(`update public.sequence_enrollments set routing_v2_engine = null where id = $1`, [r.new_enrollment_id]))
      .rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint s2");
  });

  it("a non-v2 enrollment that reached a v2 drip anyway (pre-existing / guard bypassed) is stopped as flag_off, never sent", async () => {
    await setFlags(db, ctx.org, FLAGS_ON); // even with every flag on
    const v2 = (await db.query(`select id from public.sequences where org_id = $1 and routing_v2_key = 'price_too_high'`, [ctx.org])).rows[0].id;
    await db.query(`update public.sequence_enrollments set status = 'completed', completed_at = now(), next_run_at = null where id = $1`, [ctx.legacyEnrollment]);
    await db.query("set local session_replication_role = replica"); // bypass the insert guard
    const foreign = (await db.query(
      `insert into public.sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at)
       values ($1,$2,$3,$4,'active',0, now()) returning id`,
      [ctx.org, v2, ctx.property, ctx.contact],
    )).rows[0].id;
    await db.query("set local session_replication_role = origin");
    const run = await stepRun(db, foreign);
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [foreign, run.id])).rows[0].r).toBe("flag_off");
    expect((await db.query(`select status, ended_reason from public.sequence_enrollments where id = $1`, [foreign])).rows[0])
      .toEqual({ status: "completed", ended_reason: "flag_off" });
    expect((await db.query(`select public.routing_v2_enrollment_send_check($1) as r`, [foreign])).rows[0].r).toBe("not_active");
    const fence = await authorize(db, ctx, foreign, run);
    expect(fence.authorized).toBe(false);
  });

  it("provenance: a caller-supplied routing_v2_engine='v2' is refused outside route_reply_transition", async () => {
    const v2 = (await db.query(`select id from public.sequences where org_id = $1 and routing_v2_key = 'price_too_high'`, [ctx.org])).rows[0].id;
    await db.query(`update public.sequence_enrollments set status = 'completed', completed_at = now(), next_run_at = null where id = $1`, [ctx.legacyEnrollment]);
    await db.query("savepoint p");
    // Direct insert (even with full table privileges) claiming to be v2.
    await expect(db.query(
      `insert into public.sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at, routing_v2_engine)
       values ($1,$2,$3,$4,'active',0, now(), 'v2')`,
      [ctx.org, v2, ctx.property, ctx.contact],
    )).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED: routing v2 enrollments are created by route_reply_transition only/);
    await db.query("rollback to savepoint p");
    // Same insert as the authenticated API role.
    await db.query("set local role authenticated");
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: randomUUID(), role: "authenticated" })]);
    await expect(db.query(
      `insert into public.sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at, routing_v2_engine)
       values ($1,$2,$3,$4,'active',0, now(), 'v2')`,
      [ctx.org, v2, ctx.property, ctx.contact],
    )).rejects.toThrow();
    await db.query("rollback to savepoint p");
    await db.query("reset role");
    // Re-marking a legacy row as v2 is refused too.
    await expect(db.query(`update public.sequence_enrollments set routing_v2_engine = 'v2' where id = $1`, [ctx.legacyEnrollment]))
      .rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint p");
    expect((await db.query(`select count(*)::int as n from public.sequence_enrollments where routing_v2_engine = 'v2' and org_id = $1`, [ctx.org])).rows[0].n).toBe(0);
    // The route function still enrolls (it sets the transaction-local marker itself)...
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "price_too_high" });
    expect(r.outcome).toBe("applied");
    expect(r.new_enrollment_id).toBeTruthy();
    // ...and clears it afterwards, so a later direct insert in the same transaction is still refused.
    expect((await db.query(`select coalesce(current_setting('routing_v2.enrolling', true), '') as v`)).rows[0].v).toBe("");
    await db.query("savepoint q");
    await expect(db.query(`update public.sequence_enrollments set routing_v2_inbound_id = $2 where id = $1`, [r.new_enrollment_id, randomUUID()]))
      .rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint q");
  });

  it("final Said they'd call step sends -> plain completed; NO Book appointment enrollment is created", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "said_theyd_call" });
    const e = r.new_enrollment_id;
    // Walk to the last step (index 5) the way advanceEnrollment does.
    await db.query(`update public.sequence_enrollments set current_step_index = 5, next_run_at = now() where id = $1`, [e]);
    const run = await stepRun(db, e);
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [e, run.id])).rows[0].r).toBe("ok");
    const pendingMsg = (await db.query(
      `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, status)
       values ($1,$2,$3,'outbound','sms','last step','pending') returning id`,
      [ctx.org, ctx.property, ctx.contact],
    )).rows[0].id;
    const fence = await authorize(db, ctx, e, run, pendingMsg);
    expect(fence).toMatchObject({ authorized: true });
    await db.query(`select public.routing_v2_record_provider_outcome($1, 'accepted', $2)`, [run.id, pendingMsg]);
    // tick.ts (v2): one RPC completes (no next drip configured, so nothing chains).
    expect((await db.query(`select public.routing_v2_advance_after_send($1, 5, $2) as r`, [e, run.id])).rows[0].r).toBe("completed");
    expect((await db.query(`select public.routing_v2_chain_after_completion($1) as r`, [e])).rows[0].r).toBeNull();
    const rows = await enrollments(db, ctx.property);
    expect(rows.filter((x) => x.status === "active" || x.status === "paused")).toHaveLength(0);
    expect(rows.filter((x) => x.routing_v2_key === "book_appointment")).toHaveLength(0);
    expect(rows.find((x) => x.id === e)).toMatchObject({ status: "completed", ended_reason: null });
  });

  it("completions that must NOT chain: legacy final step, a v2 drip with no next drip, rerouted, flag_off, DNC-locked", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const chain = async (e: string) => (await db.query(`select public.routing_v2_chain_after_completion($1) as r`, [e])).rows[0].r;
    // Legacy final step.
    await db.query(`update public.sequence_enrollments set status = 'completed', completed_at = now(), next_run_at = null where id = $1`, [ctx.legacyEnrollment]);
    expect(await chain(ctx.legacyEnrollment)).toBeNull();
    // v2 with no next drip (Price too high).
    const a = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "price_too_high" });
    await db.query(`update public.sequence_enrollments set status = 'completed', completed_at = now(), next_run_at = null where id = $1`, [a.new_enrollment_id]);
    expect(await chain(a.new_enrollment_id)).toBeNull();
    // Rerouted Said they'd call (a newer reply retired it).
    const b = await transition(db, await inbound(db, ctx, "2026-10-30T15:01:00Z"), ctx.property, { sequence_key: "said_theyd_call" });
    await transition(db, await inbound(db, ctx, "2026-10-30T15:02:00Z"), ctx.property, { sequence_key: "vacant_land" });
    expect(await chain(b.new_enrollment_id)).toBeNull();
    // flag_off-stopped Said they'd call.
    const c = await transition(db, await inbound(db, ctx, "2026-10-30T15:03:00Z"), ctx.property, { sequence_key: "said_theyd_call" });
    await setFlags(db, ctx.org, { ...FLAGS_ON, drips: false });
    expect((await db.query(`select public.routing_v2_enrollment_send_check($1) as r`, [c.new_enrollment_id])).rows[0].r).toBe("flag_off");
    expect(await chain(c.new_enrollment_id)).toBeNull();
    // Completed normally but the property is now DNC-locked.
    await setFlags(db, ctx.org, FLAGS_ON);
    const d = await transition(db, await inbound(db, ctx, "2026-10-30T15:04:00Z"), ctx.property, { sequence_key: "said_theyd_call" });
    await db.query(`update public.sequence_enrollments set status = 'completed', completed_at = now(), next_run_at = null where id = $1`, [d.new_enrollment_id]);
    await db.query("set local session_replication_role = replica");
    await lockDnc(db, ctx.property);
    await db.query("set local session_replication_role = origin");
    expect(await chain(d.new_enrollment_id)).toBeNull();
    expect((await enrollments(db, ctx.property)).filter((x) => x.status === "active")).toHaveLength(0);
  });

  it.each([
    { drips: false, replies: false, outcome: "flag_off", enrolled: false, retired: false, outbox: 0, replyClaim: null },
    { drips: true, replies: false, outcome: "applied", enrolled: true, retired: true, outbox: 0, replyClaim: null },
    { drips: false, replies: true, outcome: "replies_only", enrolled: false, retired: false, outbox: 2, replyClaim: "ok" },
    { drips: true, replies: true, outcome: "applied", enrolled: true, retired: true, outbox: 2, replyClaim: "ok" },
  ])("slices work on their own: drips=$drips replies=$replies -> $outcome", async (c) => {
    await setFlags(db, ctx.org, { ...FLAGS_ON, drips: c.drips, replies: c.replies });
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, {
      sequence_key: "price_too_high",
      outbox: [{ kind: "reply", payload: {} }, { kind: "alert", payload: {} }],
    });
    expect(r.outcome).toBe(c.outcome);
    expect(Boolean(r.new_enrollment_id)).toBe(c.enrolled);
    expect(r.retired_enrollment_ids.includes(ctx.legacyEnrollment)).toBe(c.retired);
    const legacy = (await db.query(`select status from public.sequence_enrollments where id = $1`, [ctx.legacyEnrollment])).rows[0].status;
    expect(legacy).toBe(c.retired ? "completed" : "active");
    const rows = (await db.query(`select id, kind from public.routing_v2_outbox where inbound_message_id = $1`, [id])).rows;
    expect(rows).toHaveLength(c.outbox);
    const reply = rows.find((x) => x.kind === "reply");
    if (c.replyClaim) expect((await db.query(`select public.routing_v2_claim_outbox($1) as r`, [reply!.id])).rows[0].r).toBe(c.replyClaim);
  });

  it("no chain when the seller replied after the drip started (newer inbound, or a newer transition)", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const chain = async (e: string) => (await db.query(`select public.routing_v2_chain_after_completion($1) as r`, [e])).rows[0].r;
    const complete = (e: string) => db.query(`update public.sequence_enrollments set status = 'completed', completed_at = now(), next_run_at = null where id = $1`, [e]);
    // (a) newer inbound not routed yet
    const a = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "said_theyd_call" });
    await complete(a.new_enrollment_id);
    await inbound(db, ctx, "2026-10-30T16:00:00Z");
    expect(await chain(a.new_enrollment_id)).toBeNull();
    expect((await enrollments(db, ctx.property)).filter((x) => x.status === "active")).toHaveLength(0);
  });

  it("no chain when a newer non-superseded transition exists (even if its inbound row is the only newer one)", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const first = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const a = await transition(db, first, ctx.property, { sequence_key: "said_theyd_call" });
    await db.query(`update public.sequence_enrollments set status = 'completed', completed_at = now(), next_run_at = null where id = $1`, [a.new_enrollment_id]);
    // A newer reply routed with replies only (drips off) leaves the completed drip alone but must still block the chain.
    await setFlags(db, ctx.org, { ...FLAGS_ON, drips: false });
    expect((await transition(db, await inbound(db, ctx, "2026-10-30T15:30:00Z"), ctx.property, {})).outcome).toBe("replies_only");
    await setFlags(db, ctx.org, FLAGS_ON);
    expect((await db.query(`select public.routing_v2_chain_after_completion($1) as r`, [a.new_enrollment_id])).rows[0].r).toBeNull();
  });

  it("atomic advance: routing_v2_advance_after_send advances, then completes (no chain); a stale call changes nothing", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "said_theyd_call" });
    const runs: Record<number, string> = {};
    const adv = async (i: number) => {
      runs[i] ??= (await acceptedClaim(db, r.new_enrollment_id)).id;
      return (await db.query(`select public.routing_v2_advance_after_send($1,$2,$3) as r`, [r.new_enrollment_id, i, runs[i]])).rows[0].r;
    };
    expect(await adv(0)).toBe("advanced");
    expect(await adv(0)).toBe("changed"); // retry of the same step: no double advance
    for (let i = 1; i < 5; i++) expect(await adv(i)).toBe("advanced");
    expect(await adv(5)).toBe("completed");
    expect(await adv(5)).toBe("changed");
    const rows = await enrollments(db, ctx.property);
    expect(rows.filter((x) => x.status === "active")).toHaveLength(0);
    expect(rows.find((x) => x.id === r.new_enrollment_id)).toMatchObject({ status: "completed", ended_reason: null });
  });

  it("atomic advance: an empty Book appointment drip can't affect a Said they'd call completion (nothing chains)", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "said_theyd_call" });
    await db.query(`update public.sequence_enrollments set current_step_index = 5 where id = $1`, [r.new_enrollment_id]);
    const book = (await db.query(`select id from public.sequences where org_id = $1 and routing_v2_key = 'book_appointment'`, [ctx.org])).rows[0].id;
    await db.query("set local routing_v2.allow_drip_edit = 'on'");
    await db.query(`delete from public.sequence_steps where sequence_id = $1 and step_index = 0`, [book]);
    await db.query("set local routing_v2.allow_drip_edit = ''");
    const run5 = await acceptedClaim(db, r.new_enrollment_id);
    expect((await db.query(`select public.routing_v2_advance_after_send($1, 5, $2) as r`, [r.new_enrollment_id, run5.id])).rows[0].r).toBe("completed");
  });

  it("C2: a newer reply that lands before the final advance wins: the advance changes nothing", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "said_theyd_call" });
    await db.query(`update public.sequence_enrollments set current_step_index = 5 where id = $1`, [r.new_enrollment_id]);
    const run5 = await acceptedClaim(db, r.new_enrollment_id);
    await transition(db, await inbound(db, ctx, "2026-10-30T15:10:00Z"), ctx.property, { sequence_key: "vacant_land" });
    expect((await db.query(`select public.routing_v2_advance_after_send($1, 5, $2) as r`, [r.new_enrollment_id, run5.id])).rows[0].r).toBe("changed");
    expect((await db.query(`select status, ended_reason from public.sequence_enrollments where id = $1`, [r.new_enrollment_id])).rows[0])
      .toEqual({ status: "completed", ended_reason: "rerouted" });
    expect((await enrollments(db, ctx.property)).filter((x) => x.status === "active").map((x) => x.routing_v2_key)).toEqual(["vacant_land"]);
  });

  it("C3: the final claim close and the completion commit together (one RPC)", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "vacant_land" });
    await db.query(`update public.sequence_enrollments set current_step_index = 4 where id = $1`, [r.new_enrollment_id]);
    const run = await stepRun(db, r.new_enrollment_id);
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [r.new_enrollment_id, run.id])).rows[0].r).toBe("ok");
    await db.query(`select public.routing_v2_record_provider_outcome($1, 'accepted', null)`, [run.id]);
    expect((await db.query(`select public.routing_v2_advance_after_send($1, 4, $2) as r`, [r.new_enrollment_id, run.id])).rows[0].r).toBe("completed");
    expect((await db.query(`select status from public.routing_v2_drip_send_claims where step_run_id = $1`, [run.id])).rows[0].status).toBe("sent");
    expect((await db.query(`select status, ended_reason from public.sequence_enrollments where id = $1`, [r.new_enrollment_id])).rows[0])
      .toEqual({ status: "completed", ended_reason: null });
  });

  it("S3: not_sent is terminal and only from open; later replies never list it as cancelled", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "price_too_high" });
    const run = await stepRun(db, r.new_enrollment_id);
    await db.query(`select public.routing_v2_claim_drip_send($1,$2)`, [r.new_enrollment_id, run.id]);
    expect((await db.query(`select public.routing_v2_mark_drip_claim_sent($1, 'not_sent') as id`, [run.id])).rows[0].id).toBeTruthy();
    expect((await db.query(`select status from public.routing_v2_drip_send_claims where step_run_id = $1`, [run.id])).rows[0].status).toBe("not_sent");
    // Not from a terminal state.
    expect((await db.query(`select public.routing_v2_mark_drip_claim_sent($1, 'not_sent') as id`, [run.id])).rows[0].id).toBeNull();
    const t = await transition(db, await inbound(db, ctx, "2026-10-30T15:10:00Z"), ctx.property, { sequence_key: "vacant_land" });
    expect(t.cancelled_drip_claim_ids).toEqual([]);
  });

  it("S4: routing_v2_stop_disabled stops active+paused v2 rows and pending intents of disabled slices; legacy can enroll again", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, {
      sequence_key: "price_too_high", outbox: [{ kind: "reply", payload: {} }],
    });
    await db.query(`update public.sequence_enrollments set status = 'paused', pause_reason = 'person_took_over' where id = $1`, [r.new_enrollment_id]);
    await setFlags(db, ctx.org, { ...FLAGS_ON, drips: false, replies: false });
    const counts = (await db.query(`select public.routing_v2_stop_disabled() as c`)).rows[0].c;
    expect(counts.enrollments_stopped).toBeGreaterThanOrEqual(1);
    expect(counts.outbox_cancelled).toBeGreaterThanOrEqual(1);
    expect((await db.query(`select status, ended_reason from public.sequence_enrollments where id = $1`, [r.new_enrollment_id])).rows[0])
      .toEqual({ status: "completed", ended_reason: "flag_off" });
    expect((await db.query(`select status, cancel_reason from public.routing_v2_outbox where inbound_message_id = (select routing_v2_inbound_id from public.sequence_enrollments where id = $1)`, [r.new_enrollment_id])).rows[0])
      .toEqual({ status: "cancelled", cancel_reason: "flag_off" });
    // Nothing v2 is live on the property any more: a legacy enrollment can start (one live drip per property).
    await db.query(
      `insert into public.sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at)
       values ($1,$2,$3,$4,'active',0, now())`, [ctx.org, ctx.listedSrc, ctx.property, ctx.contact]);
    // Idempotent: nothing left to stop.
    expect((await db.query(`select public.routing_v2_stop_disabled() as c`)).rows[0].c).toMatchObject({ enrollments_stopped: 0 });
  });

  it("S4: stop_disabled on a DNC-locked property uses the compliance opt-out; enabled properties are untouched", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "price_too_high" });
    expect((await db.query(`select public.routing_v2_stop_disabled() as c`)).rows[0].c).toMatchObject({ enrollments_stopped: 0, enrollments_opted_out: 0 });
    await setFlags(db, ctx.org, { ...FLAGS_ON, drips: false });
    await db.query("set local session_replication_role = replica");
    await lockDnc(db, ctx.property);
    await db.query("set local session_replication_role = origin");
    expect((await db.query(`select public.routing_v2_stop_disabled() as c`)).rows[0].c).toMatchObject({ enrollments_opted_out: 1 });
    expect((await db.query(`select status, pause_reason from public.sequence_enrollments where id = $1`, [r.new_enrollment_id])).rows[0])
      .toEqual({ status: "opted_out", pause_reason: "dnc" });
  });

  it("S1: a v2 drip can never be a copy source", async () => {
    const v2 = (await db.query(`select id from public.sequences where org_id = $1 and routing_v2_key = 'book_appointment'`, [ctx.org])).rows[0].id;
    const target = (await db.query(`insert into public.sequences (org_id, name, active) values ($1, 'empty target', true) returning id`, [ctx.org])).rows[0].id;
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: randomUUID(), role: "authenticated" })]);
    await db.query("savepoint c");
    await expect(db.query(`select public.sequence_copy_steps($1, $2)`, [target, v2])).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED: routing v2 drips cannot be copied/);
    await db.query("rollback to savepoint c");
    expect((await db.query(`select count(*)::int as n from public.sequence_steps where sequence_id = $1`, [target])).rows[0].n).toBe(0);
  });

  it("S6/R8: deleting an organization removes every routing v2 row (no manual v2 cleanup)", async () => {
    await db.query("set local routing_v2.allow_drip_edit = ''");
    // Seed a row in EVERY v2 table: transitions, outbox, claims, v2 enrollment (+ step run),
    // v2 sequences and steps.
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, {
      sequence_key: "price_too_high", outbox: [{ kind: "reply", payload: {} }, { kind: "alert", payload: {} }],
    });
    await acceptedClaim(db, r.new_enrollment_id);
    const counts = async () => (await db.query(
      `select
         (select count(*)::int from public.routing_v2_reply_transitions where org_id = $1) as transitions,
         (select count(*)::int from public.routing_v2_outbox where org_id = $1) as outbox,
         (select count(*)::int from public.routing_v2_drip_send_claims where org_id = $1) as claims,
         (select count(*)::int from public.sequence_enrollments where org_id = $1 and routing_v2_engine = 'v2') as enrollments,
         (select count(*)::int from public.sequence_step_runs sr join public.sequence_enrollments e on e.id = sr.enrollment_id where e.org_id = $1) as step_runs,
         (select count(*)::int from public.sequences where org_id = $1 and routing_v2_key is not null) as sequences,
         (select count(*)::int from public.sequence_steps st join public.sequences s2 on s2.id = st.sequence_id where s2.org_id = $1 and s2.routing_v2_key is not null) as steps`,
      [ctx.org])).rows[0];
    const before = await counts();
    for (const [k, v] of Object.entries(before)) expect(v, k).toBeGreaterThan(0);
    // Direct delete of a v2 drip is still refused while the org exists.
    await db.query("savepoint o");
    const v2 = (await db.query(`select id from public.sequences where org_id = $1 and routing_v2_key is not null limit 1`, [ctx.org])).rows[0].id;
    await expect(db.query(`delete from public.sequences where id = $1`, [v2])).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint o");
    // Only the pre-existing NON-v2 parents that block an org delete (no-action FKs) are removed,
    // with cascades off so nothing v2 is touched by them.
    await db.query("set local session_replication_role = replica");
    for (const t of ["messages", "message_threads", "consent_events", "sms_phone_suppressions", "ai_responder_configs", "properties", "contacts"]) {
      await db.query(`delete from public.${t} where org_id = $1`, [ctx.org]);
    }
    await db.query("set local session_replication_role = origin");
    expect(await counts()).toEqual(before); // every v2 row still there
    await db.query(`delete from public.organizations where id = $1`, [ctx.org]);
    expect(await counts()).toEqual({ transitions: 0, outbox: 0, claims: 0, enrollments: 0, step_runs: 0, sequences: 0, steps: 0 });
  });

  it("R8 self-sweep: every routing v2 table has its FKs with the parent's cascade convention", async () => {
    const fks = (await db.query(
      `select conrelid::regclass::text as tbl, a.attname as col, confrelid::regclass::text as parent, confdeltype as del
       from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and conrelid::regclass::text in ('routing_v2_reply_transitions','routing_v2_outbox','routing_v2_drip_send_claims')
       order by 1, 2`)).rows;
    expect(fks).toEqual([
      { tbl: "routing_v2_drip_send_claims", col: "enrollment_id", parent: "sequence_enrollments", del: "c" },
      { tbl: "routing_v2_drip_send_claims", col: "org_id", parent: "organizations", del: "c" },
      { tbl: "routing_v2_drip_send_claims", col: "property_id", parent: "properties", del: "c" },
      { tbl: "routing_v2_drip_send_claims", col: "step_run_id", parent: "sequence_step_runs", del: "c" },
      { tbl: "routing_v2_outbox", col: "inbound_message_id", parent: "messages", del: "c" },
      { tbl: "routing_v2_outbox", col: "org_id", parent: "organizations", del: "c" },
      { tbl: "routing_v2_outbox", col: "property_id", parent: "properties", del: "c" },
      { tbl: "routing_v2_reply_transitions", col: "inbound_message_id", parent: "messages", del: "c" },
      { tbl: "routing_v2_reply_transitions", col: "new_enrollment_id", parent: "sequence_enrollments", del: "n" },
      { tbl: "routing_v2_reply_transitions", col: "org_id", parent: "organizations", del: "c" },
      { tbl: "routing_v2_reply_transitions", col: "property_id", parent: "properties", del: "c" },
    ]);
    // RLS on, and no API role can read or write these tables directly.
    const rls = (await db.query(`select relname, relrowsecurity from pg_class where relname in ('routing_v2_reply_transitions','routing_v2_outbox','routing_v2_drip_send_claims') order by 1`)).rows;
    expect(rls.every((x) => x.relrowsecurity)).toBe(true);
    const grants = (await db.query(
      `select table_name, grantee from information_schema.role_table_grants
       where table_name in ('routing_v2_reply_transitions','routing_v2_outbox','routing_v2_drip_send_claims')
         and grantee in ('anon','authenticated','public') order by 1`)).rows;
    expect(grants).toEqual([]);
    // ended_reason only takes the known values.
    await db.query("savepoint er");
    await expect(db.query(`update public.sequence_enrollments set ended_reason = 'bogus' where id = $1`, [ctx.legacyEnrollment])).rejects.toThrow(/ended_reason_check/);
    await db.query("rollback to savepoint er");
  });

  it("R2: an inbound newer than the claim (not classified, no transition yet) makes the final advance a no-op", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "vacant_land" });
    await db.query(`update public.sequence_enrollments set current_step_index = 4 where id = $1`, [r.new_enrollment_id]);
    const run = await stepRun(db, r.new_enrollment_id);
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [r.new_enrollment_id, run.id])).rows[0].r).toBe("ok");
    // Backdate the claim, then a seller message arrives (no transition, no classification).
    await db.query(`update public.routing_v2_drip_send_claims set created_at = now() - interval '1 minute' where step_run_id = $1`, [run.id]);
    await db.query(
      `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, created_at)
       values ($1,$2,$3,'inbound','sms','wait, call me', now())`, [ctx.org, ctx.property, ctx.contact]);
    await db.query(`select public.routing_v2_record_provider_outcome($1, 'accepted', null)`, [run.id]);
    expect((await db.query(`select public.routing_v2_advance_after_send($1, 4, $2) as r`, [r.new_enrollment_id, run.id])).rows[0].r).toBe("changed");
    expect((await db.query(`select status from public.sequence_enrollments where id = $1`, [r.new_enrollment_id])).rows[0].status).toBe("active");
    // The text did go out: the claim still records it.
    expect((await db.query(`select status from public.routing_v2_drip_send_claims where step_run_id = $1`, [run.id])).rows[0].status).toBe("sent");
  });

  it("R1/R3: crash after the provider accepted (claim close + advance never ran): the reconcile closes the claim, a retry completes once, never a second send", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "vacant_land" });
    const e = r.new_enrollment_id;
    await db.query(`update public.sequence_enrollments set current_step_index = 4 where id = $1`, [e]);
    const run = await stepRun(db, e);
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [e, run.id])).rows[0].r).toBe("ok");
    const msg = (await db.query(
      `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, status, created_at)
       values ($1,$2,$3,'outbound','sms','last','pending', now() - interval '1 day') returning id`, [ctx.org, ctx.property, ctx.contact])).rows[0].id;
    expect((await authorize(db, ctx, e, run, msg)).authorized).toBe(true);
    // Provider accepted and the tick recorded the run... then crashed.
    await db.query(`update public.sequence_step_runs set attempt_outcome = 'accepted', run_at = now() where id = $1`, [run.id]);
    await db.query(`update public.routing_v2_drip_send_claims set created_at = now() - interval '20 minutes' where step_run_id = $1`, [run.id]);
    await db.query(`update public.sequence_step_runs set attempt_started_at = now() - interval '20 minutes' where id = $1 and attempt_started_at is not null`, [run.id]);
    // A fresh claim (too young) is not touched.
    const counts = (await db.query(`select public.routing_v2_reconcile_claims(interval '10 minutes') as c`)).rows[0].c;
    expect(counts).toEqual({ sent: 1, unknown: 0, not_sent: 0 });
    const claim = (await db.query(`select status, reconciled_at from public.routing_v2_drip_send_claims where step_run_id = $1`, [run.id])).rows[0];
    expect(claim.status).toBe("sent");
    expect(claim.reconciled_at).not.toBeNull();
    // A retry of the same step cannot claim (and so cannot send) again.
    await db.query("savepoint dup");
    await expect(stepRun(db, e)).rejects.toThrow(/duplicate key|unique/i);
    await db.query("rollback to savepoint dup");
    // Re-running the advance completes the drip exactly once.
    expect((await db.query(`select public.routing_v2_advance_after_send($1, 4, $2) as r`, [e, run.id])).rows[0].r).toBe("completed");
    expect((await db.query(`select public.routing_v2_advance_after_send($1, 4, $2) as r`, [e, run.id])).rows[0].r).toBe("changed");
  });

  it("R5: accepted send + failed run write -> reconcile 'sent' -> resume advances past the step; the SMS is never sent twice", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "price_too_high" });
    const e = r.new_enrollment_id;
    const run = await stepRun(db, e); // step 0
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [e, run.id])).rows[0].r).toBe("ok");
    const msg = (await db.query(
      `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, status, created_at)
       values ($1,$2,$3,'outbound','sms','step 1','pending', now() - interval '1 day') returning id`, [ctx.org, ctx.property, ctx.contact])).rows[0].id;
    expect((await authorize(db, ctx, e, run, msg)).authorized).toBe(true);
    // Provider accepted -> the tick's own small write onto the claim...
    expect((await db.query(`select public.routing_v2_record_provider_outcome($1, 'accepted', $2) as ok`, [run.id, msg])).rows[0].ok).toBe(true);
    // ...then the sequence_step_runs write FAILS (run left as authorize wrote it) and the tick holds.
    await db.query(`update public.sequence_enrollments set status = 'paused', pause_reason = 'reconciliation_required' where id = $1`, [e]);
    await db.query(`update public.routing_v2_drip_send_claims set created_at = now() - interval '20 minutes' where step_run_id = $1`, [run.id]);
    await db.query(`update public.sequence_step_runs set attempt_started_at = now() - interval '20 minutes' where id = $1 and attempt_started_at is not null`, [run.id]);
    expect((await db.query(`select public.routing_v2_reconcile_claims(interval '10 minutes') as c`)).rows[0].c).toMatchObject({ sent: 1, not_sent: 0 });
    // Even a late not_sent can't overwrite the recorded acceptance.
    expect((await db.query(`select public.routing_v2_mark_drip_claim_sent($1, 'not_sent') as id`, [run.id])).rows[0].id).toBeNull();
    // Resume (operator / service): advances past the sent step instead of retrying it.
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    const resumed = (await db.query(`select * from public.resume_sequence_enrollment($1)`, [e])).rows[0];
    expect(resumed.outcome).toBe("resumed");
    expect((await db.query(`select status, current_step_index from public.sequence_enrollments where id = $1`, [e])).rows[0])
      .toEqual({ status: "active", current_step_index: 1 });
    // The old step cannot be claimed or authorized again (no duplicate SMS)...
    await db.query("savepoint r5");
    await expect(stepRun(db, e).then(() => db.query(
      `insert into public.sequence_step_runs (enrollment_id, step_id, scheduled_for, attempt_outcome) values ($1, $2, now(), 'not_attempted')`, [e, run.step_id],
    ))).rejects.toThrow(/duplicate key|unique/i);
    await db.query("rollback to savepoint r5");
    expect((await authorize(db, ctx, e, run, msg)).authorized).toBe(false);
    // ...and the drip moves on: the next step claims and authorizes normally.
    const next = await stepRun(db, e);
    expect(next.step_id).not.toBe(run.step_id);
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [e, next.id])).rows[0].r).toBe("ok");
    const msg2 = (await db.query(
      `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, status, created_at)
       values ($1,$2,$3,'outbound','sms','step 2','pending', now() - interval '1 day') returning id`, [ctx.org, ctx.property, ctx.contact])).rows[0].id;
    expect((await authorize(db, ctx, e, next, msg2)).authorized).toBe(true);
    // Exactly one provider attempt was ever authorized for the first step.
    expect((await db.query(`select attempt_count, attempt_outcome from public.sequence_step_runs where id = $1`, [run.id])).rows[0])
      .toEqual({ attempt_count: 1, attempt_outcome: "accepted" });
  });

  it("R5: the claim acceptance write ALSO failed -> reconcile 'unknown' (never not_sent) -> resume refuses", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "price_too_high" });
    const e = r.new_enrollment_id;
    const run = await stepRun(db, e);
    await db.query(`select public.routing_v2_claim_drip_send($1,$2)`, [e, run.id]);
    const msg = (await db.query(
      `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, status, created_at)
       values ($1,$2,$3,'outbound','sms','step 1','pending', now() - interval '1 day') returning id`, [ctx.org, ctx.property, ctx.contact])).rows[0].id;
    expect((await authorize(db, ctx, e, run, msg)).authorized).toBe(true);
    await db.query(`update public.sequence_enrollments set status = 'paused', pause_reason = 'reconciliation_required' where id = $1`, [e]);
    await db.query(`update public.routing_v2_drip_send_claims set created_at = now() - interval '20 minutes' where step_run_id = $1`, [run.id]);
    await db.query(`update public.sequence_step_runs set attempt_started_at = now() - interval '20 minutes' where id = $1 and attempt_started_at is not null`, [run.id]);
    expect((await db.query(`select public.routing_v2_reconcile_claims(interval '10 minutes') as c`)).rows[0].c).toEqual({ sent: 0, unknown: 1, not_sent: 0 });
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    expect((await db.query(`select * from public.resume_sequence_enrollment($1)`, [e])).rows[0].outcome).toBe("reconciliation_required");
    expect((await db.query(`select status from public.sequence_enrollments where id = $1`, [e])).rows[0].status).toBe("paused");
  });

  it("R7: advance refuses with a null claim, another enrollment's or step's claim, or no recorded acceptance; nothing advances", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "price_too_high" });
    const e = r.new_enrollment_id;
    const state = async () => (await db.query(`select status, current_step_index from public.sequence_enrollments where id = $1`, [e])).rows[0];
    const adv = async (step: number, runId: string | null) =>
      (await db.query(`select public.routing_v2_advance_after_send($1,$2,$3) as r`, [e, step, runId])).rows[0].r;
    // null claim
    expect(await adv(0, null)).toBe("refused");
    // claim with no recorded acceptance (provider never reached) -> refused, and mark 'sent' refused too
    const bare = await stepRun(db, e);
    await db.query(`select public.routing_v2_claim_drip_send($1,$2)`, [e, bare.id]);
    expect(await adv(0, bare.id)).toBe("refused");
    expect((await db.query(`select public.routing_v2_mark_drip_claim_sent($1, 'sent') as id`, [bare.id])).rows[0].id).toBeNull();
    expect((await db.query(`select status from public.routing_v2_drip_send_claims where step_run_id = $1`, [bare.id])).rows[0].status).toBe("open");
    // 'unknown' is still allowed (never advances)
    expect((await db.query(`select public.routing_v2_mark_drip_claim_sent($1, 'unknown') as id`, [bare.id])).rows[0].id).toBeTruthy();
    expect(await adv(0, bare.id)).toBe("refused");
    expect(await state()).toEqual({ status: "active", current_step_index: 0 });
    // A claim from another enrollment (second property) is refused.
    const p2 = (await db.query(
      `insert into public.properties (org_id, address, state, status, homeowner_contact_id) values ($1,'9 Other St','MO','new_lead',$2) returning id`,
      [ctx.org, ctx.contact])).rows[0].id;
    const id2 = (await db.query(
      `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, created_at)
       values ($1,$2,$3,'inbound','sms','hi', now() - interval '500 days') returning id`, [ctx.org, p2, ctx.contact])).rows[0].id;
    const other = (await db.query(`select public.route_reply_transition($1,$2,$3::jsonb) as r`, [id2, p2, JSON.stringify({ sequence_key: "price_too_high" })])).rows[0].r;
    const foreign = await acceptedClaim(db, other.new_enrollment_id);
    expect(await adv(0, foreign.id)).toBe("refused");
    // A claim for a different step of this enrollment is refused.
    await db.query(`update public.sequence_enrollments set current_step_index = 1 where id = $1`, [e]);
    const step1 = await acceptedClaim(db, e);
    await db.query(`update public.sequence_enrollments set current_step_index = 0 where id = $1`, [e]);
    expect(await adv(0, step1.id)).toBe("refused");
    expect(await state()).toEqual({ status: "active", current_step_index: 0 });
    // The normal accepted path still works.
    await db.query(`update public.sequence_enrollments set current_step_index = 1 where id = $1`, [e]);
    expect(await adv(1, step1.id)).toBe("advanced");
    expect(await state()).toEqual({ status: "active", current_step_index: 2 });
  });

  it("R6 order A: reconcile closes a never-authorized stale claim; the slow worker's authorize is then refused, nothing sent", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "price_too_high" });
    const e = r.new_enrollment_id;
    const run = await stepRun(db, e);
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [e, run.id])).rows[0].r).toBe("ok");
    // The worker stalls between claim and authorize; the claim ages past the window.
    await db.query(`update public.routing_v2_drip_send_claims set created_at = now() - interval '20 minutes' where step_run_id = $1`, [run.id]);
    expect((await db.query(`select public.routing_v2_reconcile_claims(interval '10 minutes') as c`)).rows[0].c).toEqual({ sent: 0, unknown: 0, not_sent: 1 });
    const msg = (await db.query(
      `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, status, created_at)
       values ($1,$2,$3,'outbound','sms','late','pending', now() - interval '1 day') returning id`, [ctx.org, ctx.property, ctx.contact])).rows[0].id;
    const fence = await authorize(db, ctx, e, run, msg);
    expect(fence).toMatchObject({ authorized: false, reason: "routing v2 drip claim is not open" });
    expect((await db.query(`select attempt_outcome, message_id from public.sequence_step_runs where id = $1`, [run.id])).rows[0])
      .toEqual({ attempt_outcome: "definitively_rejected", message_id: null });
  });

  it("R6 order B: the worker authorizes first: reconcile leaves the in-flight claim alone and the send is recorded as sent", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "vacant_land" });
    const e = r.new_enrollment_id;
    await db.query(`update public.sequence_enrollments set current_step_index = 4 where id = $1`, [e]);
    const run = await stepRun(db, e);
    await db.query(`select public.routing_v2_claim_drip_send($1,$2)`, [e, run.id]);
    await db.query(`update public.routing_v2_drip_send_claims set created_at = now() - interval '20 minutes' where step_run_id = $1`, [run.id]);
    const msg = (await db.query(
      `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, status, created_at)
       values ($1,$2,$3,'outbound','sms','slow','pending', now() - interval '1 day') returning id`, [ctx.org, ctx.property, ctx.contact])).rows[0].id;
    expect((await authorize(db, ctx, e, run, msg)).authorized).toBe(true);
    // Provider call in flight: reconcile must not touch it.
    expect((await db.query(`select public.routing_v2_reconcile_claims(interval '10 minutes') as c`)).rows[0].c).toEqual({ sent: 0, unknown: 0, not_sent: 0 });
    expect((await db.query(`select status from public.routing_v2_drip_send_claims where step_run_id = $1`, [run.id])).rows[0].status).toBe("open");
    // Provider accepts -> claim acceptance + run write + advance.
    await db.query(`select public.routing_v2_record_provider_outcome($1, 'accepted', $2)`, [run.id, msg]);
    await db.query(`update public.sequence_step_runs set attempt_outcome = 'accepted', run_at = now() where id = $1`, [run.id]);
    expect((await db.query(`select public.routing_v2_advance_after_send($1, 4, $2) as r`, [e, run.id])).rows[0].r).toBe("completed");
    expect((await db.query(`select status, anomaly from public.routing_v2_drip_send_claims where step_run_id = $1`, [run.id])).rows[0])
      .toEqual({ status: "sent", anomaly: null });
  });

  it("R6: the provider's truth wins over an earlier not_sent close (promoted atomically, anomaly recorded)", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "price_too_high" });
    const run = await stepRun(db, r.new_enrollment_id);
    await db.query(`select public.routing_v2_claim_drip_send($1,$2)`, [r.new_enrollment_id, run.id]);
    await db.query(`select public.routing_v2_mark_drip_claim_sent($1, 'not_sent')`, [run.id]);
    await db.query(`select public.routing_v2_record_provider_outcome($1, 'accepted', null)`, [run.id]);
    expect((await db.query(`select status, anomaly, provider_outcome from public.routing_v2_drip_send_claims where step_run_id = $1`, [run.id])).rows[0])
      .toEqual({ status: "sent", anomaly: "provider_accepted_after_not_sent", provider_outcome: "accepted" });
    // Same via the claim-close path.
    const run2Claim = await db.query(`update public.routing_v2_drip_send_claims set status = 'not_sent', anomaly = null where step_run_id = $1`, [run.id]);
    expect(run2Claim.rowCount).toBe(1);
    await db.query(`select public.routing_v2_mark_drip_claim_sent($1, 'sent')`, [run.id]);
    expect((await db.query(`select status, anomaly from public.routing_v2_drip_send_claims where step_run_id = $1`, [run.id])).rows[0])
      .toEqual({ status: "sent", anomaly: "provider_sent_after_not_sent" });
  });

  it("R6: legacy authorization is unchanged (no v2 claim needed)", async () => {
    await db.query(`update public.sequence_enrollments set current_step_index = 0 where id = $1`, [ctx.legacyEnrollment]);
    const run = await stepRun(db, ctx.legacyEnrollment);
    const msg = (await db.query(
      `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, status, created_at)
       values ($1,$2,$3,'outbound','sms','legacy','pending', now() - interval '1 day') returning id`, [ctx.org, ctx.property, ctx.contact])).rows[0].id;
    expect((await authorize(db, ctx, ctx.legacyEnrollment, run, msg)).authorized).toBe(true);
  });

  it("R3: reconcile maps step-run truth: unknown -> unknown, not attempted -> not_sent; young claims untouched", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const r = await transition(db, await inbound(db, ctx, "2026-10-30T15:00:00Z"), ctx.property, { sequence_key: "price_too_high" });
    const run = await stepRun(db, r.new_enrollment_id);
    await db.query(`select public.routing_v2_claim_drip_send($1,$2)`, [r.new_enrollment_id, run.id]);
    expect((await db.query(`select public.routing_v2_reconcile_claims(interval '10 minutes') as c`)).rows[0].c).toEqual({ sent: 0, unknown: 0, not_sent: 0 });
    await db.query(`update public.routing_v2_drip_send_claims set created_at = now() - interval '20 minutes' where step_run_id = $1`, [run.id]);
    await db.query(`update public.sequence_step_runs set attempt_started_at = now() - interval '20 minutes' where id = $1 and attempt_started_at is not null`, [run.id]);
    expect((await db.query(`select public.routing_v2_reconcile_claims(interval '10 minutes') as c`)).rows[0].c).toEqual({ sent: 0, unknown: 0, not_sent: 1 });
  });

  it("generic alerts are gated on replies: drips=true, replies=false -> the alert does not send", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    await transition(db, id, ctx.property, { outbox: [{ kind: "alert", payload: {} }] });
    const row = (await db.query(`select id, slice from public.routing_v2_outbox where inbound_message_id = $1`, [id])).rows[0];
    expect(row.slice).toBe("replies");
    await setFlags(db, ctx.org, { ...FLAGS_ON, drips: true, replies: false });
    expect((await db.query(`select public.routing_v2_claim_outbox($1) as r`, [row.id])).rows[0].r).toBe("flag_off");
  });

  it("provenance cannot be spoofed: authenticated and service_role setting the marker themselves are refused", async () => {
    const v2 = (await db.query(`select id from public.sequences where org_id = $1 and routing_v2_key = 'price_too_high'`, [ctx.org])).rows[0].id;
    await db.query(`update public.sequence_enrollments set status = 'completed', completed_at = now(), next_run_at = null where id = $1`, [ctx.legacyEnrollment]);
    const insertV2 = () => db.query(
      `insert into public.sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at, routing_v2_engine)
       values ($1,$2,$3,$4,'active',0, now(), 'v2')`,
      [ctx.org, v2, ctx.property, ctx.contact],
    );
    for (const role of ["service_role", "authenticated"]) {
      await db.query("savepoint sp");
      await db.query(`set local role ${role}`);
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: randomUUID(), role })]);
      await db.query(`select set_config('routing_v2.enrolling', 'on', true)`); // the spoof
      if (role === "service_role") {
        await expect(insertV2()).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED: routing v2 enrollments are created by route_reply_transition only/);
      } else {
        await expect(insertV2()).rejects.toThrow();
      }
      await db.query("rollback to savepoint sp");
    }
    await db.query("reset role");
    expect((await db.query(`select count(*)::int as n from public.sequence_enrollments where org_id = $1 and routing_v2_engine = 'v2'`, [ctx.org])).rows[0].n).toBe(0);
    // The route function, called as service_role, still enrolls.
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    await db.query("set local role service_role");
    const r = (await db.query(`select public.route_reply_transition($1,$2,$3::jsonb) as r`, [id, ctx.property, JSON.stringify({ sequence_key: "price_too_high" })])).rows[0].r;
    await db.query("reset role");
    expect(r.outcome).toBe("applied");
    expect(r.new_enrollment_id).toBeTruthy();
  });

  it("a v2 enrollment can never drop its engine, even while re-pointing to a legacy drip", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "price_too_high" });
    await db.query("savepoint e");
    await expect(db.query(
      `update public.sequence_enrollments set sequence_id = $2, routing_v2_engine = null where id = $1`,
      [r.new_enrollment_id, ctx.bookSrc],
    )).rejects.toThrow(/cannot drop its engine/);
    await db.query("rollback to savepoint e");
    await expect(db.query(`update public.sequence_enrollments set routing_v2_engine = null where id = $1`, [r.new_enrollment_id]))
      .rejects.toThrow(/cannot drop its engine/);
    await db.query("rollback to savepoint e");
  });

  it("v2 drips are SMS-only: a non-SMS step is refused even with the migration opt-in", async () => {
    const v2 = (await db.query(`select id from public.sequences where org_id = $1 and routing_v2_key = 'book_appointment'`, [ctx.org])).rows[0].id;
    await db.query("set local routing_v2.allow_drip_edit = 'on'");
    await db.query("savepoint v");
    await expect(db.query(
      `insert into public.sequence_steps (sequence_id, step_index, delay_after_previous_minutes, action_type, target_status) values ($1, 50, 0, 'change_status', 'contacted')`,
      [v2],
    )).rejects.toThrow(/SMS-only/);
    await db.query("rollback to savepoint v");
    await db.query("set local routing_v2.allow_drip_edit = ''");
  });

  it("inbound calls do not pause v2 drips; legacy drips still pause exactly as before", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    // Second property of the same homeowner keeps a legacy drip.
    const p2 = (await db.query(
      `insert into public.properties (org_id, address, state, status, homeowner_contact_id) values ($1,'2 Test St','MO','new_lead',$2) returning id`,
      [ctx.org, ctx.contact],
    )).rows[0].id;
    const legacy2 = (await db.query(
      `insert into public.sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at)
       values ($1,$2,$3,$4,'active',0, now() + interval '1 day') returning id`,
      [ctx.org, ctx.listedSrc, p2, ctx.contact],
    )).rows[0].id;
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "said_theyd_call" });
    const paused = (await db.query(`select * from public.pause_enrollments_for_inbound_call($1::uuid[])`, [[ctx.contact]])).rows;
    expect(paused.map((x) => x.id)).toEqual([legacy2]);
    const st = async (e: string) => (await db.query(`select status, pause_reason from public.sequence_enrollments where id = $1`, [e])).rows[0];
    expect(await st(r.new_enrollment_id)).toEqual({ status: "active", pause_reason: null });
    expect(await st(legacy2)).toEqual({ status: "paused", pause_reason: "inbound_call" });
  });

  it("S2: seed inlines template text (no template refs on v2 steps); editing/deleting the template leaves v2 unchanged", async () => {
    await db.query("set local routing_v2.allow_drip_edit = 'on'");
    await db.query(ROLLBACK.replace(/raise exception 'routing v2 enrollments exist[^']*';/, "null;").replace(/raise exception 'enrollments point at routing v2 drips[^']*';/, "null;"));
    const tpl = (await db.query(`insert into public.sms_templates (org_id, name, content) values ($1, 'Day 98', 'Template day 98 text') returning id`, [ctx.org])).rows[0].id;
    await db.query(`update public.sequence_steps set template_body = null, template_id = $2 where sequence_id = $1 and step_index = 6`, [ctx.bookSrc, tpl]);
    await db.query(MIGRATION);
    await db.query("set local routing_v2.allow_drip_edit = ''");
    const v2 = (await db.query(
      `select st.template_body, st.template_id, st.template_category from public.sequence_steps st join public.sequences s on s.id = st.sequence_id
       where s.org_id = $1 and s.routing_v2_key = 'book_appointment' and st.step_index = 6`, [ctx.org])).rows[0];
    expect(v2).toEqual({ template_body: "Template day 98 text", template_id: null, template_category: null });
    const refs = (await db.query(
      `select count(*)::int as n from public.sequence_steps st join public.sequences s on s.id = st.sequence_id
       where s.org_id = $1 and s.routing_v2_key is not null and (st.template_id is not null or st.template_category is not null)`, [ctx.org])).rows[0].n;
    expect(refs).toBe(0);
    await db.query(`update public.sms_templates set content = 'edited' where id = $1`, [tpl]);
    // The legacy source step still references it (pre-existing behaviour); detach that one so the
    // delete shows no v2 step is involved.
    await db.query(`update public.sequence_steps set template_id = null, template_body = 'old book 6' where sequence_id = $1 and step_index = 6`, [ctx.bookSrc]);
    await db.query(`delete from public.sms_templates where id = $1`, [tpl]); // succeeds: no v2 step references it
    const after = (await db.query(
      `select st.template_body from public.sequence_steps st join public.sequences s on s.id = st.sequence_id
       where s.org_id = $1 and s.routing_v2_key = 'book_appointment' and st.step_index = 6`, [ctx.org])).rows[0].template_body;
    expect(after).toBe("Template day 98 text");
  });

  it("S2: a later step that uses a template POOL can't be inlined: that org gets no Book v2", async () => {
    await db.query("set local routing_v2.allow_drip_edit = 'on'");
    await db.query(ROLLBACK.replace(/raise exception 'routing v2 enrollments exist[^']*';/, "null;").replace(/raise exception 'enrollments point at routing v2 drips[^']*';/, "null;"));
    await db.query(`update public.sequence_steps set template_body = null, template_category = 'Follow-up' where sequence_id = $1 and step_index = 7`, [ctx.bookSrc]);
    await db.query(MIGRATION);
    const keys = (await db.query(`select routing_v2_key from public.sequences where org_id = $1 and routing_v2_key is not null order by 1`, [ctx.org])).rows.map((x) => x.routing_v2_key);
    expect(keys).toEqual(["listed_not_selling", "price_too_high", "said_theyd_call", "vacant_land"]);
  });

  it("K1: v2 versions keep the source drip's opt-out footer setting; new drips stay without", async () => {
    await db.query("set local routing_v2.allow_drip_edit = 'on'");
    await db.query(ROLLBACK.replace(/raise exception 'routing v2 enrollments exist[^']*';/, "null;").replace(/raise exception 'enrollments point at routing v2 drips[^']*';/, "null;"));
    await db.query(`update public.sequences set append_opt_out = true where id = $1`, [ctx.bookSrc]);
    await db.query(`update public.sequences set append_opt_out = false where id = $1`, [ctx.listedSrc]);
    await db.query(MIGRATION);
    const rows = Object.fromEntries((await db.query(
      `select routing_v2_key, append_opt_out from public.sequences where org_id = $1 and routing_v2_key is not null`, [ctx.org],
    )).rows.map((x) => [x.routing_v2_key, x.append_opt_out]));
    expect(rows).toEqual({ book_appointment: true, listed_not_selling: false, price_too_high: false, said_theyd_call: false, vacant_land: false });
  });

  it("seed: an org whose existing Book appointment has a non-SMS later step gets NO Book v2 (never a silently dropped step)", async () => {
    await db.query("set local routing_v2.allow_drip_edit = 'on'");
    await db.query(ROLLBACK.replace(/raise exception 'routing v2 enrollments exist[^']*';/, "null;").replace(/raise exception 'enrollments point at routing v2 drips[^']*';/, "null;"));
    await db.query(
      `update public.sequence_steps set action_type = 'change_status', template_body = null, target_status = 'contacted' where sequence_id = $1 and step_index = 7`,
      [ctx.bookSrc],
    );
    await db.query(MIGRATION);
    const keys = (await db.query(`select routing_v2_key from public.sequences where org_id = $1 and routing_v2_key is not null order by 1`, [ctx.org])).rows.map((x) => x.routing_v2_key);
    expect(keys).toEqual(["listed_not_selling", "price_too_high", "said_theyd_call", "vacant_land"]);
  });

  it("a reply that cancelled a claim while the provider call was in flight is corrected when the provider accepted", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const first = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, first, ctx.property, { sequence_key: "price_too_high" });
    const run = await stepRun(db, r.new_enrollment_id);
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [r.new_enrollment_id, run.id])).rows[0].r).toBe("ok");
    const reply = await inbound(db, ctx, "2026-10-30T15:10:00Z");
    const t = await transition(db, reply, ctx.property, { sequence_key: "vacant_land" });
    expect(t.cancelled_drip_claim_ids).toHaveLength(1);
    await db.query(`update public.routing_v2_drip_send_claims set provider_outcome = 'accepted' where step_run_id = $1`, [run.id]);
    const claimId = (await db.query(`select public.routing_v2_mark_drip_claim_sent($1, 'sent') as id`, [run.id])).rows[0].id;
    expect(claimId).toBe(t.cancelled_drip_claim_ids[0]);
    expect((await db.query(`select status from public.routing_v2_drip_send_claims where id = $1`, [claimId])).rows[0].status).toBe("sent");
    expect((await db.query(`select cancelled_drip_claim_ids from public.routing_v2_reply_transitions where inbound_message_id = $1`, [reply])).rows[0].cancelled_drip_claim_ids).toEqual([]);
    // 'unknown' is recorded as unknown; bad outcomes are rejected; legacy step runs have no claim.
    await db.query("savepoint m");
    await expect(db.query(`select public.routing_v2_mark_drip_claim_sent($1, 'cancelled')`, [run.id])).rejects.toThrow(/ROUTING_V2_BAD_CLAIM_OUTCOME/);
    await db.query("rollback to savepoint m");
    expect((await db.query(`select public.routing_v2_mark_drip_claim_sent($1, 'sent') as id`, [randomUUID()])).rows[0].id).toBeNull();
  });

  it("outbox items store engine + slice, and EVERY kind (alerts too) is re-checked at claim time", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    await transition(db, id, ctx.property, {
      outbox: [{ kind: "reply", payload: {} }, { kind: "alert", payload: {} }, { kind: "alert", slice: "alert_on_time_only", payload: {} }],
    });
    const rows = (await db.query(
      `select id, kind, engine, slice from public.routing_v2_outbox where inbound_message_id = $1 order by kind, slice`, [id],
    )).rows;
    expect(rows.map(({ kind, engine, slice }) => ({ kind, engine, slice }))).toEqual([
      { kind: "alert", engine: "v2", slice: "alert_on_time_only" },
      { kind: "alert", engine: "v2", slice: "replies" },
      { kind: "reply", engine: "v2", slice: "replies" },
    ]);
    const claim = async (rowId: string) => (await db.query(`select public.routing_v2_claim_outbox($1) as r`, [rowId])).rows[0].r;
    // questions_live off -> nothing sends, alerts included.
    await setFlags(db, ctx.org, { ...FLAGS_ON, questions_live: false });
    for (const row of rows) expect(await claim(row.id)).toBe("flag_off");
  });

  it("an alert's own slice gates it: slice off -> flag_off, slice on -> ok", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    await transition(db, id, ctx.property, {
      outbox: [{ kind: "alert", payload: {} }, { kind: "alert", slice: "alert_on_time_only", payload: {} }],
    });
    const bySlice = Object.fromEntries((await db.query(
      `select slice, id from public.routing_v2_outbox where inbound_message_id = $1`, [id],
    )).rows.map((r) => [r.slice, r.id]));
    await setFlags(db, ctx.org, { ...FLAGS_ON, alert_on_time_only: false });
    expect((await db.query(`select public.routing_v2_claim_outbox($1) as r`, [bySlice.alert_on_time_only])).rows[0].r).toBe("flag_off");
    expect((await db.query(`select public.routing_v2_claim_outbox($1) as r`, [bySlice.replies])).rows[0].r).toBe("ok");
    // An unknown slice is never enabled, so no intent is created for it.
    const bogusId = await inbound(db, ctx, "2026-10-30T15:05:00Z");
    await transition(db, bogusId, ctx.property, { outbox: [{ kind: "alert", slice: "bogus", payload: {} }] });
    expect((await db.query(`select count(*)::int as n from public.routing_v2_outbox where inbound_message_id = $1`, [bogusId])).rows[0].n).toBe(0);
  });

  it("a sent claim is consumed: a later reply does not report it as cancelled", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const first = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, first, ctx.property, { sequence_key: "price_too_high" });
    const run = await stepRun(db, r.new_enrollment_id);
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [r.new_enrollment_id, run.id])).rows[0].r).toBe("ok");
    await db.query(`select public.routing_v2_record_provider_outcome($1, 'accepted', null)`, [run.id]);
    await db.query(`select public.routing_v2_mark_drip_claim_sent($1)`, [run.id]);
    const reply = await inbound(db, ctx, "2026-10-30T15:10:00Z");
    const t = await transition(db, reply, ctx.property, { sequence_key: "vacant_land" });
    expect(t.cancelled_drip_claim_ids).toEqual([]);
    expect((await db.query(`select status from public.routing_v2_drip_send_claims where step_run_id = $1`, [run.id])).rows[0].status).toBe("sent");
  });

  it("check-and-claim after the reply already retired the enrollment: refused, no claim row", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const first = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, first, ctx.property, { sequence_key: "price_too_high" });
    const run = await stepRun(db, r.new_enrollment_id);
    const reply = await inbound(db, ctx, "2026-10-30T15:10:00Z");
    await transition(db, reply, ctx.property, { sequence_key: "vacant_land" });
    expect((await db.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [r.new_enrollment_id, run.id])).rows[0].r).toBe("not_active");
    expect((await db.query(`select count(*)::int as n from public.routing_v2_drip_send_claims where step_run_id = $1`, [run.id])).rows[0].n).toBe(0);
  });

  it("v2 drips are not editable outside migrations (incl. active, archive, metadata, delete); legacy drips unaffected", async () => {
    const v2 = (await db.query(`select id from public.sequences where org_id = $1 and routing_v2_key = 'book_appointment'`, [ctx.org])).rows[0].id;
    await db.query("savepoint s");
    await expect(db.query(`update public.sequence_steps set template_body = 'x' where sequence_id = $1 and step_index = 0`, [v2])).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint s");
    await expect(db.query(`delete from public.sequence_steps where sequence_id = $1`, [v2])).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint s");
    await expect(db.query(
      `insert into public.sequence_steps (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body) values ($1, 99, 0, 'send_sms', 'x')`,
      [v2],
    )).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint s");
    await expect(db.query(`update public.sequences set append_opt_out = true where id = $1`, [v2])).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint s");
    await expect(db.query(`update public.sequences set active = true where id = $1`, [v2])).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint s");
    // Archive / restore, metadata, delete, and creating or converting a v2 drip are all refused.
    for (const sql of [
      `update public.sequences set archived_at = now() where id = $1`,
      `update public.sequences set name = 'renamed', description = 'x' where id = $1`,
      `update public.sequences set updated_at = now() where id = $1`,
      `delete from public.sequences where id = $1`,
    ]) {
      await expect(db.query(sql, [v2])).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
      await db.query("rollback to savepoint s");
    }
    await expect(db.query(`update public.sequences set routing_v2_key = 'vacant_land', routing_v2_version = 9 where id = $1`, [ctx.bookSrc]))
      .rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint s");
    await expect(db.query(
      `insert into public.sequences (org_id, name, active, routing_v2_key, routing_v2_version) values ($1, 'fake v2', false, 'vacant_land', 7)`,
      [ctx.org],
    )).rejects.toThrow(/ROUTING_V2_DRIP_LOCKED/);
    await db.query("rollback to savepoint s");
    await db.query(`update public.sequence_steps set template_body = 'edited' where sequence_id = $1 and step_index = 0`, [ctx.bookSrc]);
    await db.query(`update public.sequences set append_opt_out = false where id = $1`, [ctx.bookSrc]);
  });
});

describe("R4: SQL canary eligibility == flags.ts isV2Eligible (400 ids x 24 configs)", () => {
  it("matches exactly, including malformed configs (fail closed)", async () => {
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
      { canary_property_ids: [], canary_percent: 50 },
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
    expect(configs).toHaveLength(24);
    let mismatches = 0;
    let malformedEligible = 0;
    for (const [i, cfg] of configs.entries()) {
      const flags = parseRoutingV2Flags(cfg);
      const sql = (await db.query(
        `select t.id::text as id, public.routing_v2_canary_eligible($1::jsonb, t.id) as ok from unnest($2::uuid[]) t(id)`,
        [JSON.stringify(cfg), propertyIds],
      )).rows as Array<{ id: string; ok: boolean }>;
      for (const row of sql) {
        if (isV2Eligible(flags, row.id) !== row.ok) mismatches += 1;
        if (i >= 12 && row.ok) malformedEligible += 1;
      }
    }
    expect(mismatches).toBe(0);
    expect(malformedEligible).toBe(0);
    const half = (await db.query(
      `select count(*) filter (where public.routing_v2_canary_eligible('{"canary_percent":50}'::jsonb, t.id)) c from unnest($1::uuid[]) t(id)`,
      [propertyIds],
    )).rows[0].c;
    expect(Number(half)).toBeGreaterThan(120);
    expect(Number(half)).toBeLessThan(280);
  });

  it("routing_v2_slice_enabled uses it: a malformed canary config disables every slice", async () => {
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      const ctx = await seedOrg(db);
      await db.query("set local session_replication_role = origin");
      const enabled = async () => (await db.query(`select public.routing_v2_slice_enabled($1, 'drips') as ok`, [ctx.property])).rows[0].ok;
      await setFlags(db, ctx.org, { questions_live: true, drips: true, canary_percent: 100 });
      expect(await enabled()).toBe(true);
      await setFlags(db, ctx.org, { questions_live: true, drips: true, canary_percent: "100" });
      expect(await enabled()).toBe(false);
      await setFlags(db, ctx.org, { questions_live: true, drips: true, canary_property_ids: [ctx.property.toUpperCase()], canary_percent: 0 });
      expect(await enabled()).toBe(true);
      await setFlags(db, ctx.org, { questions_live: true, drips: true, canary_property_ids: [ctx.property, "nope"], canary_percent: 100 });
      expect(await enabled()).toBe(false);
      await setFlags(db, ctx.org, { questions_live: "true", drips: true, canary_percent: 100 });
      expect(await enabled()).toBe(false);
    } finally {
      await db.query("rollback");
    }
  });
});

describe("routing v2 reply vs drip tick race (committed data, two connections)", () => {
  it("a reply landing between check-and-claim and the provider fence wins: nothing is authorized", async () => {
    const tick = new Client({ connectionString: url });
    const reply = new Client({ connectionString: url });
    await tick.connect();
    await reply.connect();
    let ctx: Ctx | null = null;
    try {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      ctx = await seedOrg(db);
      await db.query("set local session_replication_role = origin");
      await db.query("commit");
      await db.query(MIGRATION_RAW);
      await setFlags(db, ctx.org, FLAGS_ON);
      for (let round = 0; round < 5; round++) {
        const first = await inbound(db, ctx, `2026-10-30T15:0${round}:00Z`);
        const r = await transition(db, first, ctx.property, { sequence_key: "price_too_high" });
        const run = await stepRun(db, r.new_enrollment_id);
        // Tick holds the property lock inside its claim transaction while the reply arrives.
        await tick.query("begin");
        expect((await tick.query(`select public.routing_v2_claim_drip_send($1,$2) as r`, [r.new_enrollment_id, run.id])).rows[0].r).toBe("ok");
        const replyId = await inbound(db, ctx, `2026-10-30T15:0${round}:30Z`);
        const pending = transition(reply, replyId, ctx.property, { sequence_key: "vacant_land" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await tick.query("commit");
        const t = await pending;
        expect(t.outcome).toBe("applied");
        expect(t.cancelled_drip_claim_ids).toHaveLength(1);
        // The tick now reaches the provider fence: refused, never sent.
        const fence = await authorize(tick, ctx, r.new_enrollment_id, run);
        expect(fence.authorized).toBe(false);
        const active = (await enrollments(db, ctx.property)).filter((e) => e.status === "active");
        expect(active.map((e) => e.routing_v2_key)).toEqual(["vacant_land"]);
      }
    } finally {
      if (ctx) await cleanupOrg(ctx.org);
      await tick.end();
      await reply.end();
    }
  });
});

async function cleanupOrg(o: string) {
  await db.query("rollback").catch(() => undefined); // in case a failed step left a transaction open
  await db.query("begin");
  await db.query("set local routing_v2.allow_drip_edit = 'on'");
  await db.query("set local session_replication_role = replica");
  await db.query(`delete from public.routing_v2_drip_send_claims where org_id = $1`, [o]);
  await db.query(`delete from public.routing_v2_outbox where org_id = $1`, [o]);
  await db.query(`delete from public.routing_v2_reply_transitions where org_id = $1`, [o]);
  await db.query(`delete from public.sequence_step_runs where enrollment_id in (select id from public.sequence_enrollments where org_id = $1)`, [o]);
  await db.query(`delete from public.sequence_enrollments where org_id = $1`, [o]);
  await db.query(`delete from public.messages where org_id = $1`, [o]);
  await db.query(`delete from public.sequence_steps where sequence_id in (select id from public.sequences where org_id = $1)`, [o]);
  await db.query(`delete from public.sequences where org_id = $1`, [o]);
  await db.query(`delete from public.ai_responder_configs where org_id = $1`, [o]);
  await db.query(`delete from public.properties where org_id = $1`, [o]);
  await db.query(`delete from public.contacts where org_id = $1`, [o]);
  await db.query(`delete from public.organizations where id = $1`, [o]);
  await db.query("commit");
}

describe("routing v2 transition concurrency (committed data)", () => {
  it("two replies racing for one property leave exactly one active enrollment: the latest reply's", async () => {
    const a = new Client({ connectionString: url });
    const b = new Client({ connectionString: url });
    await a.connect();
    await b.connect();
    let ctx: Ctx | null = null;
    try {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      ctx = await seedOrg(db);
      await db.query("set local session_replication_role = origin");
      await db.query("commit");
      await db.query(MIGRATION_RAW);
      await setFlags(db, ctx.org, FLAGS_ON);
      for (let round = 0; round < 5; round++) {
        const older = await inbound(db, ctx, `2026-10-30T15:0${round}:00Z`);
        const newer = await inbound(db, ctx, `2026-10-30T15:0${round}:30Z`);
        await Promise.all([
          transition(a, older, ctx.property, { sequence_key: "price_too_high" }),
          transition(b, newer, ctx.property, { sequence_key: "vacant_land" }),
        ]);
        const active = (await enrollments(db, ctx.property)).filter((e) => e.status === "active");
        expect(active.map((e) => e.routing_v2_key)).toEqual(["vacant_land"]);
      }
      const dup = await inbound(db, ctx, "2026-10-30T16:00:00Z");
      const [x, y] = await Promise.all([
        transition(a, dup, ctx.property, { sequence_key: "price_too_high" }),
        transition(b, dup, ctx.property, { sequence_key: "price_too_high" }),
      ]);
      expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
      expect((await enrollments(db, ctx.property)).filter((e) => e.status === "active")).toHaveLength(1);
    } finally {
      if (ctx) await cleanupOrg(ctx.org);
      await a.end();
      await b.end();
    }
  });
});
