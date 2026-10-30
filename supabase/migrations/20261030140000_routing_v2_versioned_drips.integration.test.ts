import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ROUTING_V2_DRIPS } from "@/lib/sequences/routing-v2/drip-spec";
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
const FLAGS_ON = { questions_live: true, drips: true, replies: true, canary_property_ids: [] as string[], canary_percent: 100 };

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
const inbound = async (c: Client, ctx: Ctx, at: string) =>
  (await c.query(
    `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, created_at)
     values ($1,$2,$3,'inbound','sms','hi',$4) returning id`,
    [ctx.org, ctx.property, ctx.contact, at],
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
    const paused = (await db.query(
      `insert into public.sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, pause_reason)
       values ($1,$2,$3,$4,'paused','inbound_reply') returning id`,
      [ctx.org, ctx.listedSrc, ctx.property, ctx.contact],
    )).rows[0].id;
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "book_appointment" });
    expect(r.outcome).toBe("applied");
    expect(new Set(r.retired_enrollment_ids)).toEqual(new Set([ctx.legacyEnrollment, paused]));
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
    await db.query(`update public.properties set last_person_takeover_at = '2026-10-30T15:02:00Z' where id = $1`, [ctx.property]);
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
    expect((await db.query(`select public.routing_v2_claim_outbox($1) as r`, [row])).rows[0].r).toBe("human_takeover");
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

  it("Said they'd call chains into Book appointment v2 when it completes", async () => {
    await setFlags(db, ctx.org, FLAGS_ON);
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const r = await transition(db, id, ctx.property, { sequence_key: "said_theyd_call" });
    await db.query(`update public.sequence_enrollments set status = 'completed', completed_at = now(), next_run_at = null where id = $1`, [r.new_enrollment_id]);
    const next = (await db.query(`select public.routing_v2_chain_after_completion($1) as r`, [r.new_enrollment_id])).rows[0].r;
    expect(next).toBeTruthy();
    const active = (await enrollments(db, ctx.property)).filter((e) => e.status === "active");
    expect(active.map((e) => e.routing_v2_key)).toEqual(["book_appointment"]);
    // Book appointment itself has no next drip (drip-end behaviour is not decided).
    await db.query(`update public.sequence_enrollments set status = 'completed', next_run_at = null where id = $1`, [next]);
    expect((await db.query(`select public.routing_v2_chain_after_completion($1) as r`, [next])).rows[0].r).toBeNull();
  });
});

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
      if (ctx) {
        const o = ctx.org;
        await db.query(`delete from public.routing_v2_outbox where org_id = $1`, [o]);
        await db.query(`delete from public.routing_v2_reply_transitions where org_id = $1`, [o]);
        await db.query(`delete from public.sequence_enrollments where org_id = $1`, [o]);
        await db.query(`delete from public.messages where org_id = $1`, [o]);
        await db.query(`delete from public.sequences where org_id = $1`, [o]);
        await db.query(`delete from public.ai_responder_configs where org_id = $1`, [o]);
        await db.query(`delete from public.properties where org_id = $1`, [o]);
        await db.query(`delete from public.contacts where org_id = $1`, [o]);
        await db.query(`delete from public.organizations where id = $1`, [o]);
      }
      await a.end();
      await b.end();
    }
  });
});
