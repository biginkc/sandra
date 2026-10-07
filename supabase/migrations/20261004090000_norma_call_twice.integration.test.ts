import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";
import { applyMyLeadsChain } from "@tests/integration/my-leads-housekeeping-fixture";

// Local-only: every test runs inside one transaction that is rolled back, so
// the loopback database is left as it was found. The migration itself is
// replayed inside the transaction.
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const load = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8")
    .replace(/^\s*begin;\s*$/gim, "")
    .replace(/^\s*commit;\s*$/gim, "");
// Every Norma migration, in order: the retry replaces functions defined by several of them.
const migration = [
  "20261002120000_norma_call_requests.sql",
  "20261002120100_norma_m2_hardening.sql",
  "20261002120200_norma_m2_review_fixes.sql",
  "20261002120300_norma_dnc_lock_task_writes.sql",
  "20261002120400_norma_create_request_serialize.sql",
  "20261002120500_norma_lock_order.sql",
].map(load).join("\n");
const retryMigration = load("20261008090100_norma_retry_next_step_union_reviewed.sql");

type Ctx = { org: string; rep: string; assignee: string; sequence: string };
type Lead = { property: string; contact: string; phone: string; enrollment: string | null };

let phoneCounter = 0;
const nextPhone = () => `+1816556${String(1000 + (phoneCounter++ % 9000)).padStart(4, "0")}`;

async function withDb(fn: (db: Client, ctx: Ctx) => Promise<void>, beforeUpgrade?: (db: Client, ctx: Ctx) => Promise<void>) {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    await applyMyLeadsChain(db, []);
    await db.query(migration);
    await applyMyLeadsChain(db, ["schema", "createFn"]);
    const ctx: Ctx = { org: randomUUID(), rep: randomUUID(), assignee: randomUUID(), sequence: randomUUID() };
    await db.query("insert into auth.users(id) values ($1), ($2)", [ctx.rep, ctx.assignee]);
    await db.query("insert into public.organizations(id,name) values ($1,'norma test')", [ctx.org]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [ctx.assignee, ctx.org]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'member','active')", [ctx.rep, ctx.org]);
    await db.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Norma drip')", [ctx.sequence, ctx.org]);
    await db.query(
      "insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','hi')",
      [ctx.sequence],
    );
    if (beforeUpgrade) await beforeUpgrade(db, ctx);
    await db.query(retryMigration);
    // Explicit activation in this transaction-only retry-contract fixture.
    await db.query("update public.norma_retry_admission set enabled=true where singleton=true");
    await fn(db, ctx);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}

async function lead(
  db: Client,
  ctx: Ctx,
  opts: { enrollment?: "active" | `paused:${string}` | null; dispo?: string | null } = {},
): Promise<Lead> {
  const property = randomUUID();
  const contact = randomUUID();
  const phone = nextPhone();
  await db.query(
    "insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Seller',$3,'mobile')",
    [contact, ctx.org, phone],
  );
  await db.query(
    "insert into public.properties(id,org_id,address,state,status,homeowner_contact_id,outreach_dispo) values ($1,$2,$3,'MO','new_lead',$4,$5)",
    [property, ctx.org, `${property.slice(0, 6)} Main St`, contact, opts.dispo ?? null],
  );
  let enrollment: string | null = null;
  const mode = opts.enrollment === undefined ? "active" : opts.enrollment;
  if (mode) {
    const paused = mode.startsWith("paused:");
    enrollment = (
      await db.query<{ id: string }>(
        "insert into public.sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,pause_reason,next_run_at) values ($1,$2,$3,$4,$5,$6,now()) returning id",
        [ctx.org, ctx.sequence, property, contact, paused ? "paused" : "active", paused ? mode.slice(7) : null],
      )
    ).rows[0]!.id;
  }
  return { property, contact, phone, enrollment };
}

/** Run one statement as the service role, restoring the superuser role after. */
async function svc<T extends Record<string, unknown> = Record<string, unknown>>(db: Client, sql: string, params: unknown[] = []) {
  await db.query("set local role service_role");
  await db.query("select set_config('request.jwt.claim.role','service_role',true)");
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.query("reset role").catch(() => {});
    await db.query("select set_config('request.jwt.claim.role','',true)").catch(() => {});
  }
}

async function create(db: Client, ctx: Ctx, l: Lead, context: string | null = "ctx") {
  const r = await svc<{ outcome: string; request_id: string | null; idempotency_key: string | null; block_reason: string | null }>(
    db,
    "select * from public.fn_norma_create_request($1,$2,$3,$4,$5,$6)",
    [l.property, l.contact, l.phone, ctx.rep, context, ctx.assignee],
  );
  return r.rows[0]!;
}

const one = async <T extends Record<string, unknown>>(db: Client, sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0]!;

async function enrollmentState(db: Client, id: string) {
  return one<{ status: string; pause_reason: string | null }>(
    db,
    "select status, pause_reason from public.sequence_enrollments where id=$1",
    [id],
  );
}


type Row = {
  status: string; attempt: number; outcome: string | null; bland_call_id: string | null;
  first_bland_call_id: string | null; first_attempt_outcome: string | null; completed_at: string | null;
};
const rowOf = (db: Client, id: string) =>
  one<Row>(db, "select status, attempt, outcome, bland_call_id, first_bland_call_id, first_attempt_outcome, completed_at from public.norma_call_requests where id=$1", [id]);

const complete = async (db: Client, id: string, callId: string, outcome: string, payload: Record<string, unknown> = {}) =>
  (await svc<{ r: Record<string, unknown> }>(db, "select public.fn_norma_complete_call($1,$2,$3,$4::jsonb) as r", [id, callId, outcome, JSON.stringify(payload)])).rows[0]!.r;
const claim = async (db: Client, id: string, attempt = 1) =>
  (await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1,$2) as c", [id, attempt])).rows[0]!.c;
const bind = async (db: Client, id: string, callId: string, attempt = 1) =>
  (await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,$2,$3::integer) as b", [id, callId, attempt])).rows[0]!.b;
const bindLegacy = async (db: Client, id: string, callId: string) =>
  (await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,$2) as b", [id, callId])).rows[0]!.b;
const count = async (db: Client, sql: string, params: unknown[]) => Number((await one<{ n: string }>(db, sql, params)).n);
const events = (db: Client, id: string, type: string) =>
  count(db, "select count(*) as n from public.lead_events where event_type=$2 and payload->>'request_id'=$1", [id, type]);
const hold = async (db: Client, property: string) =>
  (await svc<{ h: boolean }>(db, "select public.fn_norma_hold_active($1) as h", [property])).rows[0]!.h;

/** A request that has been created, claimed and bound to call-1. */
async function dispatched(db: Client, ctx: Ctx, opts: Parameters<typeof lead>[2] = {}, callId = "call-1") {
  const l = await lead(db, ctx, opts);
  const id = (await create(db, ctx, l)).request_id!;
  expect(await claim(db, id)).toBe(true);
  expect(await bind(db, id, callId)).toBe("bound");
  return { l, id };
}

describe("norma call twice (migration 20261004090000)", () => {
  it("preserves existing bound review requests and protected pauses across the schema-only upgrade", async () => {
    let before: Record<string, unknown>[] = [];
    let pausesBefore: Record<string, unknown>[] = [];
    const open: { id: string; property: string; callId: string; enrollment: string; pauseReason: string }[] = [];
    await withDb(async (db) => {
      const after = (await db.query("select to_jsonb(r) - array['attempt','first_bland_call_id','first_attempt_outcome','first_attempt_at','precall_sms_status','reviewed_by','reviewed_at'] as row from public.norma_call_requests r order by id")).rows;
      expect(after).toEqual(before);
      expect((await db.query("select to_jsonb(e) as row from public.sequence_enrollments e order by id")).rows).toEqual(pausesBefore);
      for (const r of open) {
        expect(await rowOf(db, r.id)).toMatchObject({ status: "needs_review", attempt: 1, outcome: "unknown", bland_call_id: r.callId, first_bland_call_id: null });
        expect(await hold(db, r.property)).toBe(true);
        // A late confirmed no-answer for an existing review row completes it;
        // the retry transition applies only to dispatching/dispatched rows.
        expect(await complete(db, r.id, r.callId, "no_answer", { attempt: 1 })).toMatchObject({ status: "completed", outcome: "no_answer" });
        expect(await rowOf(db, r.id)).toMatchObject({ status: "completed", attempt: 1 });
        expect(await enrollmentState(db, r.enrollment)).toEqual(r.pauseReason === "norma_call" ? { status: "active", pause_reason: null } : { status: "paused", pause_reason: r.pauseReason });
      }
      // The protected enrollments belong to the completing requests, so this
      // exercises release_pauses rather than unrelated-row preservation.
      const protectedIds = open.filter((r) => r.pauseReason !== "norma_call").map((r) => r.enrollment);
      const protectedAfter = (await db.query("select to_jsonb(e) as row from public.sequence_enrollments e where id=any($1::uuid[]) order by id", [protectedIds])).rows;
      expect(protectedAfter).toEqual(pausesBefore.filter((r) => protectedIds.includes((r.row as { id: string }).id)));
    }, async (db, ctx) => {
      for (let i = 0; i < 3; i++) {
        const l = await lead(db, ctx);
        const id = (await create(db, ctx, l)).request_id!;
        expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1) as c", [id])).rows[0]!.c).toBe(true);
        const callId = `legacy-review-${i}`;
        expect(await bindLegacy(db, id, callId)).toBe("bound");
        expect(await complete(db, id, callId, "unknown")).toMatchObject({ status: "needs_review" });
        const pauseReason = ["provider_failed", "reconciliation_required", "norma_call"][i]!;
        await db.query("update public.sequence_enrollments set pause_reason=$2 where id=$1", [l.enrollment, pauseReason]);
        open.push({ id, property: l.property, callId, enrollment: l.enrollment!, pauseReason });
      }
      before = (await db.query("select to_jsonb(r) as row from public.norma_call_requests r order by id")).rows;
      pausesBefore = (await db.query("select to_jsonb(e) as row from public.sequence_enrollments e order by id")).rows;
    });
  });

  it.each(["dispatching", "dispatched", "dispatch_unknown", "unknown_recovered"] as const)("preserves and accounts for a pre-existing %s row across mixed-version upgrade", async (state) => {
    let legacy: { id: string; l: Lead };
    const callId = `legacy-${state}-1`;
    await withDb(async (db) => {
      const { id, l } = legacy;
      expect(await rowOf(db, id)).toMatchObject({ status: state === "unknown_recovered" ? "dispatch_unknown" : state, attempt: 1 });
      if (state === "unknown_recovered") expect(await bind(db, id, callId)).toBe("bound");
      // A legacy completion omits attempt metadata. It settles attempt 1 plainly;
      // it cannot schedule the retry edge.
      const result = await complete(db, id, callId, "no_answer");
      expect(result).toMatchObject({ status: "completed", outcome: "no_answer" });
      expect(result).not.toHaveProperty("retry");
      expect(await rowOf(db, id)).toMatchObject({ status: "completed", attempt: 1 });
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "active", pause_reason: null });
      expect(await hold(db, l.property)).toBe(false);
      expect(await events(db, id, "norma_call_completed")).toBe(1);
      expect(await count(db, "select count(*) as n from public.norma_notifications where request_id=$1", [id])).toBe(1);
    }, async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1) as c", [id])).rows[0]!.c).toBe(true);
      if (state === "dispatched") expect(await bindLegacy(db, id, callId)).toBe("bound");
      if (state === "dispatch_unknown" || state === "unknown_recovered") await svc(db, "select public.fn_norma_mark_dispatch_unknown($1,'legacy uncertain')", [id]);
      legacy = { id, l };
    });
  });

  it("a confirmed no_answer on attempt 1 schedules the retry on the same request, holding everything", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await dispatched(db, ctx);
      expect(await complete(db, id, "call-1", "no_answer", { attempt: 1 })).toMatchObject({ result: "applied", status: "requested", outcome: "no_answer", retry: true });
      expect(await rowOf(db, id)).toMatchObject({
        status: "requested", attempt: 2, outcome: null, bland_call_id: null,
        first_bland_call_id: "call-1", first_attempt_outcome: "no_answer", completed_at: null,
      });
      // Held across both attempts: pauses stay, the fence stays, no outcome effects yet.
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect(await hold(db, l.property)).toBe(true);
      expect(await events(db, id, "norma_call_completed")).toBe(0);
      expect(await events(db, id, "norma_call_attempt_no_answer")).toBe(1);
      expect(await count(db, "select count(*) as n from public.norma_notifications where request_id=$1", [id])).toBe(0);
      expect(await count(db, "select count(*) as n from public.tasks where source_key=$1", [`norma_call:${id}`])).toBe(0);
      // A second request for the lead is still refused.
      expect((await create(db, ctx, l)).outcome).toBe("already_open");
    });
  });

  it("idempotent: replaying attempt 1's result never schedules (or dials) another retry", async () => {
    await withDb(async (db, ctx) => {
      const { id } = await dispatched(db, ctx);
      await complete(db, id, "call-1", "no_answer", { attempt: 1 });
      for (let i = 0; i < 3; i += 1) {
        expect(await complete(db, id, "call-1", "no_answer", { attempt: 1 })).toMatchObject({ result: "replayed", status: "requested" });
        // Even a replay that now looks like a connected call changes nothing.
        expect(await complete(db, id, "call-1", "callback_requested")).toMatchObject({ result: "replayed" });
      }
      expect(await rowOf(db, id)).toMatchObject({ status: "requested", attempt: 2, first_bland_call_id: "call-1" });
      expect(await events(db, id, "norma_call_attempt_no_answer")).toBe(1);
      // Only one claim can ever win for the retry.
      expect(await claim(db, id, 2)).toBe(true);
      expect(await claim(db, id)).toBe(false);
    });
  });

  it("the second no_answer ends the request and is the only thing that releases the drip", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await dispatched(db, ctx);
      await complete(db, id, "call-1", "no_answer", { attempt: 1 });
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect(await claim(db, id, 2)).toBe(true);
      expect(await bind(db, id, "call-2", 2)).toBe("bound");
      expect(await rowOf(db, id)).toMatchObject({ status: "dispatched", attempt: 2, bland_call_id: "call-2", first_bland_call_id: "call-1" });
      // Still held while the second call is in flight.
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect(await complete(db, id, "call-2", "no_answer", { attempt: 2 })).toMatchObject({ result: "applied", status: "completed", outcome: "no_answer", released: 1 });
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "active", pause_reason: null });
      expect(await rowOf(db, id)).toMatchObject({ status: "completed", attempt: 2, outcome: "no_answer", bland_call_id: "call-2" });
      expect(await hold(db, l.property)).toBe(false);
      expect(await events(db, id, "norma_call_completed")).toBe(1);
      expect(await count(db, "select count(*) as n from public.norma_notifications where request_id=$1", [id])).toBe(1);
      // Replays of either call are no-ops; no third call is possible.
      for (const callId of ["call-1", "call-2", "call-1", "call-2"]) {
        expect(await complete(db, id, callId, "no_answer", { attempt: callId === "call-1" ? 1 : 2 })).toMatchObject({ result: "replayed", status: "completed" });
      }
      expect(await complete(db, id, "call-3", "no_answer", { attempt: 2 })).toMatchObject({ result: "call_id_mismatch" });
      expect(await events(db, id, "norma_call_completed")).toBe(1);
      expect(await claim(db, id)).toBe(false);
    });
  });

  it("a person answering the second call completes it normally, with a task, and the drip stays paused", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await dispatched(db, ctx);
      await complete(db, id, "call-1", "no_answer", { attempt: 1 });
      await claim(db, id, 2);
      await bind(db, id, "call-2", 2);
      const done = await complete(db, id, "call-2", "callback_requested", { attempt: 2, callback_raw: "tomorrow at 3" });
      expect(done).toMatchObject({ result: "applied", status: "completed", outcome: "callback_requested" });
      expect(await rowOf(db, id)).toMatchObject({ status: "completed", attempt: 2, outcome: "callback_requested" });
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect(await count(db, "select count(*) as n from public.tasks where source_key=$1", [`norma_call:${id}`])).toBe(1);
    });
  });

  it("a first call that reached a person completes at once: no retry", async () => {
    await withDb(async (db, ctx) => {
      for (const outcome of ["callback_requested", "reached_no_callback", "not_interested", "wrong_number"]) {
        const { id } = await dispatched(db, ctx, {}, `call-${outcome}`);
        const r = await complete(db, id, `call-${outcome}`, outcome);
        expect(r).toMatchObject({ result: "applied", status: "completed", outcome });
        expect(r.retry).toBeUndefined();
        expect(await rowOf(db, id)).toMatchObject({ status: "completed", attempt: 1, first_bland_call_id: null });
        expect(await events(db, id, "norma_call_attempt_no_answer")).toBe(0);
      }
    });
  });

  it("an unknown result on attempt 1 parks for review and never retries", async () => {
    await withDb(async (db, ctx) => {
      const { id } = await dispatched(db, ctx);
      expect(await complete(db, id, "call-1", "unknown")).toMatchObject({ result: "applied", status: "needs_review" });
      expect(await rowOf(db, id)).toMatchObject({ status: "needs_review", attempt: 1 });
    });
  });

  it("an unconfirmed first call is never retried: a late no_answer from dispatch_unknown / needs_review completes as a plain no_answer", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await claim(db, id);
      await svc(db, "select public.fn_norma_mark_dispatch_unknown($1,'timeout')", [id]);
      expect(await complete(db, id, "call-1", "no_answer", { attempt: 1 })).toMatchObject({ result: "applied", status: "completed", outcome: "no_answer" });
      expect(await rowOf(db, id)).toMatchObject({ status: "completed", attempt: 1, first_bland_call_id: null });

      const l2 = await lead(db, ctx);
      const id2 = (await create(db, ctx, l2)).request_id!;
      await claim(db, id2);
      await bind(db, id2, "call-9");
      await svc(db, "select public.fn_norma_mark_needs_review($1,'old')", [id2]);
      expect(await complete(db, id2, "call-9", "no_answer", { attempt: 1 })).toMatchObject({ result: "applied", status: "completed", outcome: "no_answer" });
      expect(await rowOf(db, id2)).toMatchObject({ attempt: 1 });
    });
  });

  it("webhook before the bind: the retry is scheduled, and the first call's late bind is harmless", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await claim(db, id);
      expect(await complete(db, id, "call-1", "no_answer", { attempt: 1 })).toMatchObject({ result: "applied", status: "requested", retry: true });
      expect(await bind(db, id, "call-1")).toBe("already_completed");
      expect(await rowOf(db, id)).toMatchObject({ status: "requested", attempt: 2, bland_call_id: null, first_bland_call_id: "call-1" });
    });
  });

  it("a refused retry (dispatch_rejected) releases the drip and leaves the first call on record", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await dispatched(db, ctx);
      await complete(db, id, "call-1", "no_answer", { attempt: 1 });
      expect((await svc<{ r: string }>(db, "select public.fn_norma_mark_dispatch_rejected($1,'ineligible:dnc_locked','requested',$2) as r", [id, 2])).rows[0]!.r).toBe("dispatch_rejected");
      expect(await rowOf(db, id)).toMatchObject({ status: "dispatch_rejected", attempt: 2, first_bland_call_id: "call-1" });
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "active", pause_reason: null });
      expect(await hold(db, l.property)).toBe(false);
    });
  });

  it("only the current attempt can complete a request whose current call is not bound yet", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await dispatched(db, ctx);
      await complete(db, id, "call-1", "no_answer", { attempt: 1 });
        await claim(db, id, 2); // attempt 2 dispatching, no call id yet
      const before = await rowOf(db, id);
      for (const [callId, attempt] of [["forged-1", 1], ["call-1", 1], ["forged-2", 3], ["forged-3", 0]] as const) {
        const r = await complete(db, id, callId, "callback_requested", { attempt });
        expect(r.result === "stale_attempt" || r.result === "replayed").toBe(true);
      }
      expect(await rowOf(db, id)).toEqual(before);
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect(await events(db, id, "norma_call_completed")).toBe(0);
      expect(await count(db, "select count(*) as n from public.norma_notifications where request_id=$1", [id])).toBe(0);
      expect(await count(db, "select count(*) as n from public.tasks where source_key=$1", [`norma_call:${id}`])).toBe(0);
      // The current attempt's own result (webhook before bind) still completes it.
      expect(await complete(db, id, "call-2", "callback_requested", { attempt: 2 })).toMatchObject({ result: "applied", status: "completed" });
    });
  });

  describe("STOP and the dispatch claim", () => {
    const eligible = async (db: Client, l: Lead) =>
      (await svc<{ eligible: boolean; block_reason: string | null }>(db, "select * from public.fn_norma_eligibility($1,$2,$3)", [l.property, l.contact, l.phone])).rows[0]!;

    it("eligibility refuses a seller who texted STOP (contact flag, phone suppression, opted_out disposition)", async () => {
      await withDb(async (db, ctx) => {
        const ok = await lead(db, ctx);
        expect(await eligible(db, ok)).toMatchObject({ eligible: true });
        const a = await lead(db, ctx);
        await db.query("update public.contacts set sms_opted_out = true where id = $1", [a.contact]);
        expect(await eligible(db, a)).toMatchObject({ eligible: false, block_reason: "sms_opted_out" });
        const b = await lead(db, ctx);
        await db.query("insert into public.sms_phone_suppressions (org_id, channel, phone_e164, source) values ($1,'sms',$2,'t')", [ctx.org, b.phone]);
        expect(await eligible(db, b)).toMatchObject({ eligible: false, block_reason: "sms_phone_suppressed" });
        const c = await lead(db, ctx, { dispo: "opted_out" });
        expect(await eligible(db, c)).toMatchObject({ eligible: false, block_reason: "sms_opted_out" });
      });
    });

    it("the claim is fenced on the attempt the dispatcher read", async () => {
      await withDb(async (db, ctx) => {
        const { id } = await dispatched(db, ctx);
        await complete(db, id, "call-1", "no_answer", { attempt: 1 }); // now requested, attempt 2
        const stale = (await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1, 1) as c", [id])).rows[0]!.c;
        expect(stale).toBe(false);
        expect((await rowOf(db, id)).status).toBe("requested");
        expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1, 2) as c", [id])).rows[0]!.c).toBe(true);
      });
    });
  });

  describe("the guard trigger allows only that one backwards edge", () => {
    const update = (db: Client, id: string, set: string) => db.query(`update public.norma_call_requests set ${set} where id=$1`, [id]);
    const rejects = async (db: Client, id: string, set: string, pattern: RegExp) => {
      await db.query("savepoint s");
      await expect(update(db, id, set)).rejects.toThrow(pattern);
      await db.query("rollback to savepoint s");
    };

    it("attempt cannot be changed except by the retry, status cannot go back to requested otherwise", async () => {
      await withDb(async (db, ctx) => {
        const { id } = await dispatched(db, ctx);
        await rejects(db, id, "attempt = 2", /attempt can only move/);
        await rejects(db, id, "status = 'requested'", /not allowed/);
        await rejects(db, id, "status = 'requested', attempt = 2", /not allowed|attempt|check/);
        await rejects(db, id, "first_bland_call_id = 'x'", /first attempt is recorded only/);
        await rejects(db, id, "status = 'requested', attempt = 2, first_bland_call_id = 'call-1', first_attempt_outcome = 'callback_requested', bland_call_id = null", /not allowed|check|attempt/);
        await rejects(db, id, "status = 'requested', attempt = 2, first_bland_call_id = 'other', first_attempt_outcome = 'no_answer', bland_call_id = null", /not allowed|attempt/);
      });
    });

    it("after the retry: attempt cannot go back, the first-attempt record is frozen, and the two call ids differ", async () => {
      await withDb(async (db, ctx) => {
        const { id } = await dispatched(db, ctx);
        await complete(db, id, "call-1", "no_answer", { attempt: 1 });
        await rejects(db, id, "attempt = 1", /attempt can only move/);
        await rejects(db, id, "first_bland_call_id = 'other'", /first attempt record cannot change/);
        await rejects(db, id, "first_attempt_outcome = 'callback_requested'", /first attempt record cannot change|check/);
        await claim(db, id, 2);
        await rejects(db, id, "bland_call_id = 'call-1'", /check|distinct/);
        await bind(db, id, "call-2", 2);
        await rejects(db, id, "bland_call_id = 'call-3'", /bland_call_id cannot be overwritten/);
      });
    });

    it("a dispatch_unknown request cannot be put back to requested", async () => {
      await withDb(async (db, ctx) => {
        const l = await lead(db, ctx);
        const id = (await create(db, ctx, l)).request_id!;
        await claim(db, id);
        await svc(db, "select public.fn_norma_mark_dispatch_unknown($1,'t')", [id]);
        await rejects(db, id, "status = 'requested', attempt = 2, first_bland_call_id = 'c', first_attempt_outcome = 'no_answer', bland_call_id = null", /not allowed|attempt/);
      });
    });
  });
});
