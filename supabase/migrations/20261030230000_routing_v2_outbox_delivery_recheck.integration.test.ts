import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * Routing v2 PR-F (20261030230000): delivery-time re-check of claimed outbox rows and the
 * human-takeover fence (BUILD-PLAN §14 takeover cases + Race A/B). Local-only. Each test runs
 * in a rolled-back transaction except the two-connection tests, which commit and clean up.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
const PRC_MIGRATION = strip(read("20261030140000_routing_v2_versioned_drips.sql"));
const PRC_ROLLBACK = strip(read("../rollbacks/20261030140000_routing_v2_versioned_drips.sql")).replace(
  /raise exception 'routing v2 enrollments exist[^']*';/,
  "null;",
);
const MIGRATION_RAW = read("20261030230000_routing_v2_outbox_delivery_recheck.sql");
const MIGRATION = strip(MIGRATION_RAW);
const ROLLBACK = strip(read("../rollbacks/20261030230000_routing_v2_outbox_delivery_recheck.sql"));
const DAY = 1440;
const FLAGS_ON = { questions_live: true, drips: true, replies: true, alert_on_time_only: true, canary_property_ids: [] as string[], canary_percent: 100 };

const db = new Client({ connectionString: url });
beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

type Ctx = { org: string; contact: string; property: string; legacyEnrollment: string };

async function seedOrg(c: Client): Promise<Ctx> {
  const org = randomUUID();
  await c.query("insert into public.organizations (id, name) values ($1, $2)", [org, `rv2f-${org}`]);
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
  return { org, contact, property, legacyEnrollment };
}

const setFlags = (c: Client, org: string, flags: Record<string, unknown>) =>
  c.query(`update public.ai_responder_configs set routing_v2_flags = $2::jsonb where org_id = $1`, [org, JSON.stringify(flags)]);
// Inbound times 400 days in the past, so a takeover written with now() is always after them.
const PAST_SHIFT_MS = 400 * 86_400_000;
const inbound = async (c: Client, ctx: Ctx, at: string, body = "hi") =>
  (await c.query(
    `insert into public.messages (org_id, property_id, contact_id, direction, channel, body, created_at)
     values ($1,$2,$3,'inbound','sms',$4,$5) returning id`,
    [ctx.org, ctx.property, ctx.contact, body, new Date(Date.parse(at) - PAST_SHIFT_MS).toISOString()],
  )).rows[0].id as string;
const transition = async (c: Client, inboundId: string, property: string, decision: Record<string, unknown>) =>
  (await c.query(`select public.route_reply_transition($1,$2,$3::jsonb) as r`, [inboundId, property, JSON.stringify(decision)])).rows[0].r;
const outbox = async (c: Client, inboundId: string) =>
  (await c.query(
    `select id, kind, status, cancel_reason, authorized_at from public.routing_v2_outbox where inbound_message_id = $1 order by kind`,
    [inboundId],
  )).rows as Array<{ id: string; kind: string; status: string; cancel_reason: string | null; authorized_at: Date | null }>;
const row = async (c: Client, id: string) =>
  (await c.query(`select status, cancel_reason, authorized_at is not null as authorized from public.routing_v2_outbox where id = $1`, [id])).rows[0];
const claim = async (c: Client, id: string) => (await c.query(`select public.routing_v2_claim_outbox($1) as r`, [id])).rows[0].r as string;
const authorize = async (c: Client, id: string) =>
  (await c.query(`select public.routing_v2_authorize_outbox_send($1) as r`, [id])).rows[0].r as string;
const takeover = (c: Client, property: string) =>
  c.query(`update public.properties set last_person_takeover_at = clock_timestamp() where id = $1`, [property]);
const activeV2 = async (c: Client, property: string) =>
  (await c.query(
    `select e.id, s.routing_v2_key from public.sequence_enrollments e join public.sequences s on s.id = e.sequence_id
     where e.property_id = $1 and e.status = 'active'`,
    [property],
  )).rows;
const SURE_DECISION = { sequence_key: "book_appointment", outbox: [{ kind: "reply", payload: { key: "said_yes" } }] };
const TIME_DECISION = { sequence_key: null, outbox: [{ kind: "alert", payload: { reason: "call_me" } }] };

async function applyStack(c: Client) {
  // Re-apply PR-C (seeds the v2 drips for the test org) and then PR-F on top of it.
  await c.query(PRC_ROLLBACK);
  await c.query(PRC_MIGRATION);
  await c.query(ROLLBACK);
  await c.query(MIGRATION);
}

describe("routing v2 PR-F delivery re-check + takeover fence (rolled back per test)", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    ctx = await seedOrg(db);
    await db.query("set local session_replication_role = origin");
    await applyStack(db);
    await setFlags(db, ctx.org, FLAGS_ON);
  });
  afterEach(async () => {
    await db.query("rollback");
  });

  it('"Sure" -> reply + Book appointment; "Tuesday 3pm" -> the drip stops and only the alert is delivered', async () => {
    const sure = await inbound(db, ctx, "2026-10-30T15:00:00Z", "Sure");
    const t1 = await transition(db, sure, ctx.property, SURE_DECISION);
    expect(t1.outcome).toBe("applied");
    expect((await activeV2(db, ctx.property)).map((e) => e.routing_v2_key)).toEqual(["book_appointment"]);
    const [sureReply] = await outbox(db, sure);
    expect(sureReply).toMatchObject({ kind: "reply", status: "pending" });

    const time = await inbound(db, ctx, "2026-10-30T15:05:00Z", "Tuesday 3pm");
    const t2 = await transition(db, time, ctx.property, TIME_DECISION);
    expect(t2.outcome).toBe("applied");
    expect(t2.new_enrollment_id).toBeNull();
    expect(t2.retired_enrollment_ids).toContain(t1.new_enrollment_id);
    expect(await activeV2(db, ctx.property)).toEqual([]);
    expect(await row(db, sureReply!.id)).toMatchObject({ status: "cancelled", cancel_reason: `superseded_by=${time}` });
    const [alert] = await outbox(db, time);
    expect(alert).toMatchObject({ kind: "alert", status: "pending" });
    expect(await claim(db, alert!.id)).toBe("ok");
    expect(await authorize(db, alert!.id)).toBe("ok");
    // Authorized at most once: a retried consumer can never send it twice.
    expect(await authorize(db, alert!.id)).toBe("already_authorized");
    expect(await row(db, alert!.id)).toMatchObject({ status: "claimed", authorized: true });
  });

  it("takeover after the inbound: no auto send (no reply queued, no drip), the alert intent stays", async () => {
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    await takeover(db, ctx.property);
    const t = await transition(db, id, ctx.property, {
      sequence_key: "book_appointment",
      outbox: [{ kind: "reply", payload: {} }, { kind: "alert", payload: {} }],
    });
    expect(t.outcome).toBe("takeover_blocked");
    expect(await activeV2(db, ctx.property)).toEqual([]);
    const rows = await outbox(db, id);
    expect(rows.map((r) => r.kind)).toEqual(["alert"]);
    expect(await claim(db, rows[0]!.id)).toBe("ok");
    expect(await authorize(db, rows[0]!.id)).toBe("ok");
  });

  it("Race B (pending): reply queued, then a person takes over -> the takeover itself cancels it; nothing auto-sent", async () => {
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    await transition(db, id, ctx.property, { outbox: [{ kind: "reply", payload: {} }, { kind: "alert", payload: {} }] });
    const [alert, reply] = await outbox(db, id);
    await takeover(db, ctx.property);
    expect(await row(db, reply!.id)).toMatchObject({ status: "cancelled", cancel_reason: "human_takeover" });
    expect(await claim(db, reply!.id)).toBe("not_pending");
    expect(await authorize(db, reply!.id)).toBe("not_claimed");
    // The owner's alert is not an auto send to the seller: it still goes.
    expect(await row(db, alert!.id)).toMatchObject({ status: "pending" });
    expect(await claim(db, alert!.id)).toBe("ok");
    expect(await authorize(db, alert!.id)).toBe("ok");
  });

  it("Race B (claimed): the consumer already holds the reply, then a person takes over -> the delivery re-check refuses it", async () => {
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    await transition(db, id, ctx.property, { outbox: [{ kind: "reply", payload: {} }, { kind: "alert", payload: {} }] });
    const [alert, reply] = await outbox(db, id);
    expect(await claim(db, reply!.id)).toBe("ok");
    expect(await claim(db, alert!.id)).toBe("ok");
    await takeover(db, ctx.property);
    // A claimed row may already be in flight: the fence leaves it to the delivery re-check.
    expect(await row(db, reply!.id)).toMatchObject({ status: "claimed" });
    expect(await authorize(db, reply!.id)).toBe("human_takeover");
    expect(await row(db, reply!.id)).toMatchObject({ status: "cancelled", cancel_reason: "human_takeover", authorized: false });
    expect(await authorize(db, alert!.id)).toBe("ok");
  });

  it("Race A (claimed): reply 1 claimed, reply 2 transitions before delivery -> reply 1 refused, only reply 2 sends", async () => {
    const r1 = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    await transition(db, r1, ctx.property, SURE_DECISION);
    const [row1] = await outbox(db, r1);
    expect(await claim(db, row1!.id)).toBe("ok");
    const r2 = await inbound(db, ctx, "2026-10-30T15:01:00Z");
    const t2 = await transition(db, r2, ctx.property, { sequence_key: "listed_not_selling", outbox: [{ kind: "reply", payload: {} }] });
    // A newer transition cancels only pending rows; the claimed one is still claimed here...
    expect(t2.cancelled_outbox_ids).toEqual([]);
    expect(await row(db, row1!.id)).toMatchObject({ status: "claimed" });
    // ...and the delivery-time re-check refuses it.
    expect(await authorize(db, row1!.id)).toBe("superseded");
    expect(await row(db, row1!.id)).toMatchObject({ status: "cancelled", cancel_reason: "superseded", authorized: false });
    const [row2] = await outbox(db, r2);
    expect(await claim(db, row2!.id)).toBe("ok");
    expect(await authorize(db, row2!.id)).toBe("ok");
  });

  it("claimed row: flag switched off, property dropped from the canary, DNC lock or suppression -> refused", async () => {
    const queue = async (at: string) => {
      const id = await inbound(db, ctx, at);
      await transition(db, id, ctx.property, { outbox: [{ kind: "reply", payload: {} }] });
      const [r] = await outbox(db, id);
      expect(await claim(db, r!.id)).toBe("ok");
      return r!.id;
    };
    let id = await queue("2026-10-30T15:00:00Z");
    await setFlags(db, ctx.org, { ...FLAGS_ON, replies: false });
    expect(await authorize(db, id)).toBe("flag_off");
    await setFlags(db, ctx.org, FLAGS_ON);
    id = await queue("2026-10-30T15:01:00Z");
    await setFlags(db, ctx.org, { ...FLAGS_ON, canary_percent: 0 });
    expect(await authorize(db, id)).toBe("flag_off");
    await setFlags(db, ctx.org, FLAGS_ON);
    id = await queue("2026-10-30T15:02:00Z");
    await db.query(`insert into public.sms_phone_suppressions (org_id, phone_e164, source) values ($1,'+18165550100','carrier_stop')`, [ctx.org]);
    expect(await authorize(db, id)).toBe("suppressed");
    expect(await authorize(db, randomUUID())).toBe("missing");
  });

  it("takeover with nothing queued (every flag off): the fence changes nothing", async () => {
    await setFlags(db, ctx.org, {});
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    expect((await transition(db, id, ctx.property, SURE_DECISION)).outcome).toBe("flag_off");
    const before = (await db.query(`select count(*)::int as n from public.routing_v2_outbox where org_id = $1`, [ctx.org])).rows[0].n;
    const enrBefore = (await db.query(`select id, status, pause_reason from public.sequence_enrollments where org_id = $1 order by id`, [ctx.org])).rows;
    await takeover(db, ctx.property);
    expect((await db.query(`select count(*)::int as n from public.routing_v2_outbox where org_id = $1`, [ctx.org])).rows[0].n).toBe(before);
    expect((await db.query(`select id, status, pause_reason from public.sequence_enrollments where org_id = $1 order by id`, [ctx.org])).rows).toEqual(enrBefore);
  });

  it("a takeover after a v2 Book appointment started pauses it at the next send check", async () => {
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const t = await transition(db, id, ctx.property, SURE_DECISION);
    await takeover(db, ctx.property);
    expect((await db.query(`select public.routing_v2_enrollment_send_check($1) as r`, [t.new_enrollment_id])).rows[0].r).toBe("person_took_over");
  });

  it("inbound calls never pause v2 drips (PR-H dropped)", async () => {
    const id = await inbound(db, ctx, "2026-10-30T15:00:00Z");
    const t = await transition(db, id, ctx.property, SURE_DECISION);
    await db.query(`select * from public.pause_enrollments_for_inbound_call($1::uuid[])`, [[ctx.contact]]);
    expect((await db.query(`select status from public.sequence_enrollments where id = $1`, [t.new_enrollment_id])).rows[0].status).toBe("active");
  });

  it("rollback removes every PR-F object; re-apply is idempotent; takeovers still work with PR-C rolled back", async () => {
    await db.query(MIGRATION);
    await db.query(ROLLBACK);
    const objs = (await db.query(
      `select (select count(*)::int from pg_proc where proname in ('routing_v2_authorize_outbox_send','routing_v2_takeover_fence')) as fns,
              (select count(*)::int from pg_trigger where tgname = 'trg_routing_v2_takeover_fence') as trg,
              (select count(*)::int from information_schema.columns where table_name = 'routing_v2_outbox' and column_name = 'authorized_at') as col`,
    )).rows[0];
    expect(objs).toEqual({ fns: 0, trg: 0, col: 0 });
    await db.query(MIGRATION);
    await db.query(PRC_ROLLBACK);
    await takeover(db, ctx.property); // the fence must never fail a takeover
  });
});

async function cleanupOrg(o: string) {
  await db.query("rollback").catch(() => undefined);
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

describe("routing v2 PR-F races (committed data, two connections)", () => {
  it("two consumers re-checking the same claimed row at once: exactly one is authorized", async () => {
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
      await db.query(read("20261030140000_routing_v2_versioned_drips.sql"));
      await db.query(MIGRATION_RAW);
      await setFlags(db, ctx.org, FLAGS_ON);
      for (let round = 0; round < 5; round++) {
        const id = await inbound(db, ctx, `2026-10-30T15:0${round}:00Z`);
        await transition(db, id, ctx.property, { outbox: [{ kind: "reply", payload: {} }] });
        const [r] = await outbox(db, id);
        expect(await claim(db, r!.id)).toBe("ok");
        const results = await Promise.all([authorize(a, r!.id), authorize(b, r!.id)]);
        expect(results.sort()).toEqual(["already_authorized", "ok"]);
      }
    } finally {
      if (ctx) await cleanupOrg(ctx.org);
      await a.end();
      await b.end();
    }
  });

  it("a takeover committing while a reply is queued: the consumer never gets to send it", async () => {
    const person = new Client({ connectionString: url });
    const consumer = new Client({ connectionString: url });
    await person.connect();
    await consumer.connect();
    let ctx: Ctx | null = null;
    try {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      ctx = await seedOrg(db);
      await db.query("set local session_replication_role = origin");
      await db.query("commit");
      await db.query(read("20261030140000_routing_v2_versioned_drips.sql"));
      await db.query(MIGRATION_RAW);
      await setFlags(db, ctx.org, FLAGS_ON);
      for (let round = 0; round < 5; round++) {
        // Each round starts with no takeover on record (clearing it does not fire the fence).
        await db.query(`update public.properties set last_person_takeover_at = null where id = $1`, [ctx.property]);
        const id = await inbound(db, ctx, `2026-10-30T15:0${round}:00Z`);
        await transition(db, id, ctx.property, { outbox: [{ kind: "reply", payload: {} }] });
        const [r] = await outbox(db, id);
        expect(r).toMatchObject({ kind: "reply", status: "pending" });
        // The person's takeover holds the property lock (fence) until it commits.
        await person.query("begin");
        await takeover(person, ctx.property);
        const pendingClaim = claim(consumer, r!.id);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await person.query("commit");
        expect(await pendingClaim).toBe("not_pending");
        expect(await row(db, r!.id)).toMatchObject({ status: "cancelled", cancel_reason: "human_takeover" });
      }
    } finally {
      await person.query("rollback").catch(() => undefined);
      if (ctx) await cleanupOrg(ctx.org);
      await person.end();
      await consumer.end();
    }
  });
});
