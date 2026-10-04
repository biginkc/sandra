import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RECONCILE_THRESHOLDS, reconcileNormaCalls } from "../reconcile";
import { createScratchDb, seedWorld, type Scratch, type World } from "./db";
import { createPgSupabase } from "./pg-client";

// Post-DDL contract: real committed statements on separate pooled connections.
// Production reconciliation is invoked only in the paired grace receipt; no runtime dispatcher or provider is invoked. This supplements, rather than
// rewrites, the legacy-runtime stress suite and the transactional upgrade tests.
let scratch: Scratch;
let world: World;
beforeAll(async () => {
  scratch = await createScratchDb();
  world = await seedWorld(scratch.pool);
  expect(createHash("sha256").update(readFileSync("supabase/migrations/20261004090000_norma_call_twice.sql")).digest("hex")).toBe("f386ab9e07d28372acdc37d088a82c153eba8dd2019532964d87a6a1680c3466");
  const columns = await scratch.pool.query("select column_name from information_schema.columns where table_schema='public' and table_name='norma_call_requests' and column_name='attempt'");
  expect(columns.rows).toHaveLength(1); // Refuse a mistakenly pre-DDL fixture.
});
afterAll(async () => { await scratch?.drop(); });
const q = async (sql: string, params: unknown[] = []) => (await scratch.pool.query(sql, params)).rows;
const row = async (id: string) => (await q("select * from public.norma_call_requests where id=$1", [id]))[0]!;
const claim = async (id: string, attempt: number) => (await q("select public.fn_norma_claim_dispatch($1,$2) as result", [id, attempt]))[0]!.result as boolean;
const bind = async (id: string, call: string) => (await q("select public.fn_norma_bind_call_id($1,$2) as result", [id, call]))[0]!.result as string;
const complete = async (id: string, call: string, outcome: string, attempt: number) =>
  (await q("select public.fn_norma_complete_call($1,$2,$3,$4::jsonb) as result", [id, call, outcome, JSON.stringify({ attempt })]))[0]!.result as Record<string, unknown>;
const count = async (table: "norma_notifications" | "lead_events", id: string, type?: string) => Number((await q(table === "norma_notifications"
  ? "select count(*) as n from public.norma_notifications where request_id=$1"
  : "select count(*) as n from public.lead_events where payload->>'request_id'=$1 and event_type=$2", table === "norma_notifications" ? [id] : [id, type]))[0]!.n);
// Force all 20 statements to wait on the same real row lock before release;
// concurrent Promise creation alone would not prove overlapping transactions.
async function race<T>(id: string, action: () => Promise<T>): Promise<T[]> {
  const blocker = await scratch.pool.connect();
  let pending: Promise<PromiseSettledResult<T>[]> | undefined;
  let waiterError: unknown;
  let waiters = 0;
  try {
    await blocker.query("begin");
    await blocker.query("select id from public.norma_call_requests where id=$1 for update", [id]);
    pending = Promise.allSettled(Array.from({ length: 20 }, action));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      waiters = Number((await q("select count(*) as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%fn_norma_%'"))[0]!.n);
      if (waiters === 20) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } catch (error) {
    waiterError = error;
  } finally {
    await blocker.query("rollback");
    blocker.release();
  }
  const results = pending ? await pending : [];
  if (waiterError) throw waiterError;
  for (const result of results) if (result.status === "rejected") throw result.reason;
  expect(waiters, "all workers must reach the held row lock").toBe(20);
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}
async function requested() {
  const lead = await world.nextLead({ enrollments: ["active"] });
  const r = (await q("select * from public.fn_norma_create_request($1,$2,$3,$4,$5,$6)", [lead.property, lead.contact, lead.phone, world.rep1, "schema contract", world.assignee]))[0]!;
  expect(r.outcome).toBe("created");
  return { lead, id: r.request_id as string };
}
async function dispatched() {
  const ctx = await requested();
  expect(await claim(ctx.id, 1)).toBe(true);
  expect(await bind(ctx.id, `first_${ctx.id}`)).toBe("bound");
  return ctx;
}
async function pauseRows(id: string) { return q("select * from public.norma_enrollment_pauses where request_id=$1 order by enrollment_id", [id]); }
async function enrollments(ids: string[]) { return q("select id,status,pause_reason from public.sequence_enrollments where id=any($1) order by id", [ids]); }

describe("schema-only two-call committed concurrency contract", () => {
  it("20 simultaneous first claims have one winner and preserve the one-open-request fence", async () => {
    const ctx = await requested();
    const claims = await race(ctx.id, () => claim(ctx.id, 1));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await row(ctx.id)).toMatchObject({ status: "dispatching", attempt: 1 });
    const second = (await q("select * from public.fn_norma_create_request($1,$2,$3,$4,$5,$6)", [ctx.lead.property, ctx.lead.contact, ctx.lead.phone, world.rep2, null, world.assignee]))[0]!;
    expect(second.outcome).toBe("already_open");
    expect(second.request_id).toBe(ctx.id);
    expect(await q("select id from public.norma_call_requests where property_id=$1", [ctx.lead.property])).toHaveLength(1);
  });

  it("20 concurrent first no-answers schedule exactly one retry, no final effects, and retain both holds", async () => {
    const ctx = await dispatched();
    const paused = await enrollments(ctx.lead.enrollments);
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ status: "paused", pause_reason: "norma_call" });
    const pauses = await pauseRows(ctx.id);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toMatchObject({ enrollment_id: ctx.lead.enrollments[0], released_at: null, release_result: null });
    const results = await race(ctx.id, () => complete(ctx.id, `first_${ctx.id}`, "no_answer", 1));
    expect(results.filter((r) => r.retry === true)).toHaveLength(1);
    expect(results.filter((r) => r.result === "replayed")).toHaveLength(19);
    expect(await row(ctx.id)).toMatchObject({ status: "requested", attempt: 2, first_bland_call_id: `first_${ctx.id}`, first_attempt_outcome: "no_answer", bland_call_id: null, completed_at: null });
    expect(await enrollments(ctx.lead.enrollments)).toEqual(paused);
    expect(await pauseRows(ctx.id)).toEqual(pauses);
    expect(await count("norma_notifications", ctx.id)).toBe(0);
    expect(await count("lead_events", ctx.id, "norma_call_attempt_no_answer")).toBe(1);
    expect(await count("lead_events", ctx.id, "norma_call_completed")).toBe(0);
    expect(await q("select id from public.tasks where source_key=$1", [`norma_call:${ctx.id}`])).toHaveLength(0);
    expect((await q("select public.fn_norma_hold_active($1) as held", [ctx.lead.property]))[0]!.held).toBe(true);
  });

  it("stale workers cannot claim attempt 2; concurrent current claims have one winner; forged first result is inert before bind", async () => {
    const ctx = await dispatched();
    await complete(ctx.id, `first_${ctx.id}`, "no_answer", 1);
    expect(await claim(ctx.id, 1)).toBe(false);
    expect((await race(ctx.id, () => claim(ctx.id, 2))).filter(Boolean)).toHaveLength(1);
    const before = await row(ctx.id);
    expect(await complete(ctx.id, "forged_first_id", "callback_requested", 1)).toMatchObject({ result: "stale_attempt" });
    expect(await row(ctx.id)).toEqual(before);
    expect(await count("norma_notifications", ctx.id)).toBe(0);
    expect(await bind(ctx.id, `second_${ctx.id}`)).toBe("bound");
    expect(await complete(ctx.id, "wrong_second_id", "no_answer", 2)).toMatchObject({ result: "call_id_mismatch" });
    expect(await row(ctx.id)).toMatchObject({ status: "dispatched", attempt: 2, bland_call_id: `second_${ctx.id}` });
  });

  it.each([false, true])("20 concurrent second no-answers finalize once, preserve protected=%s pause, and never schedule attempt 3", async (protectedPause) => {
    const ctx = await dispatched();
    await complete(ctx.id, `first_${ctx.id}`, "no_answer", 1);
    expect(await claim(ctx.id, 2)).toBe(true);
    expect(await bind(ctx.id, `second_${ctx.id}`)).toBe("bound");
    if (protectedPause) await q("update public.sequence_enrollments set pause_reason='provider_failed' where id=$1", [ctx.lead.enrollments[0]]);
    const pauseBefore = await enrollments(ctx.lead.enrollments);
    const results = await race(ctx.id, () => complete(ctx.id, `second_${ctx.id}`, "no_answer", 2));
    expect(results.filter((r) => r.result === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.result === "replayed")).toHaveLength(19);
    expect(await row(ctx.id)).toMatchObject({ status: "completed", attempt: 2, outcome: "no_answer" });
    expect(await claim(ctx.id, 2)).toBe(false);
    expect(await count("norma_notifications", ctx.id)).toBe(1);
    expect(await count("lead_events", ctx.id, "norma_call_completed")).toBe(1);
    const after = await enrollments(ctx.lead.enrollments);
    if (protectedPause) expect(after).toEqual(pauseBefore);
    else expect(after[0]).toMatchObject({ status: "active", pause_reason: null });
    expect((await q("select public.fn_norma_hold_active($1) as held", [ctx.lead.property]))[0]!.held).toBe(false);
    expect(await complete(ctx.id, `first_${ctx.id}`, "no_answer", 1)).toMatchObject({ result: "replayed" });
    expect(await row(ctx.id)).toMatchObject({ status: "completed", attempt: 2 });
  });

  it("terminal outbox failure rolls back every effect and a concurrent replay then applies once", async () => {
    const ctx = await dispatched();
    await complete(ctx.id, `first_${ctx.id}`, "no_answer", 1);
    expect(await claim(ctx.id, 2)).toBe(true);
    expect(await bind(ctx.id, `second_${ctx.id}`)).toBe("bound");
    const before = await row(ctx.id);
    const pauses = await enrollments(ctx.lead.enrollments);
    const pauseLedger = await pauseRows(ctx.id);
    const attemptEvents = await count("lead_events", ctx.id, "norma_call_attempt_no_answer");
    expect(attemptEvents).toBe(1);
    await q("insert into stress.fault(property_id,tbl) values ($1,'norma_notifications')", [ctx.lead.property]);
    await expect(complete(ctx.id, `second_${ctx.id}`, "no_answer", 2)).rejects.toThrow("injected database failure");
    expect(await row(ctx.id)).toEqual(before);
    expect(await enrollments(ctx.lead.enrollments)).toEqual(pauses);
    expect(await pauseRows(ctx.id)).toEqual(pauseLedger);
    expect(await count("lead_events", ctx.id, "norma_call_attempt_no_answer")).toBe(attemptEvents);
    expect(await count("lead_events", ctx.id, "norma_call_completed")).toBe(0);
    expect(await count("norma_notifications", ctx.id)).toBe(0);
    await q("delete from stress.fault where property_id=$1", [ctx.lead.property]);
    const results = await race(ctx.id, () => complete(ctx.id, `second_${ctx.id}`, "no_answer", 2));
    expect(results.filter((r) => r.result === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.result === "replayed")).toHaveLength(19);
    expect(await count("lead_events", ctx.id, "norma_call_attempt_no_answer")).toBe(attemptEvents);
    expect(await count("norma_notifications", ctx.id)).toBe(1);
    expect(await count("lead_events", ctx.id, "norma_call_completed")).toBe(1);
  });

  it.each(["reached_no_callback", "unknown"])("%s on attempt 1 never creates a retry", async (outcome) => {
    const ctx = await dispatched();
    await complete(ctx.id, `first_${ctx.id}`, outcome, 1);
    expect(await row(ctx.id)).toMatchObject({ status: outcome === "unknown" ? "needs_review" : "completed", attempt: 1, first_bland_call_id: null });
    expect(await claim(ctx.id, 2)).toBe(false);
    expect(await count("lead_events", ctx.id, "norma_call_attempt_no_answer")).toBe(0);
  });
});


describe("paired-runtime retry grace contract", () => {
  it("fresh attempt 2 uses updated_at grace despite an old created_at", async () => {
    const ctx = await dispatched();
    // Existing scratch clock helper shifts stored timestamps with triggers off,
    // modelling elapsed time without violating the immutable-identity trigger.
    await scratch.advance(10 * 60_000);
    expect(await complete(ctx.id, `first_${ctx.id}`, "no_answer", 1)).toMatchObject({ retry: true });
    expect(await row(ctx.id)).toMatchObject({ status: "requested", attempt: 2 });
    const before = await row(ctx.id);
    const ledger = await pauseRows(ctx.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ released_at: null, release_result: null });
    expect(Date.now() - Date.parse(before.created_at)).toBeGreaterThan(9 * 60_000);
    expect(Math.abs(Date.now() - Date.parse(before.updated_at))).toBeLessThan(5000);
    const now = Date.now() + 5000;
    expect(Date.parse(before.next_check_at)).toBeLessThanOrEqual(now);
    let dispatchCalls = 0;
    const summary = await reconcileNormaCalls({
      client: createPgSupabase(scratch.pool, { actor: "paired-reconcile" }),
      bland: null,
      dispatch: async () => { dispatchCalls += 1; return { status: "not_claimed" }; },
      now,
    });
    expect(summary.errors).toBe(0);
    expect(summary.scanned).toBeGreaterThan(0);
    expect(dispatchCalls).toBe(0);
    const after = await row(ctx.id);
    expect(after).toMatchObject({ status: "requested", attempt: 2, bland_call_id: null });
    // The target scheduling write proves this specific row was examined.
    expect(Date.parse(after.next_check_at)).toBe(now + RECONCILE_THRESHOLDS.recheckAfterRequested);
    expect(await pauseRows(ctx.id)).toEqual(ledger);
    expect((await enrollments(ctx.lead.enrollments))[0]).toMatchObject({ status: "paused", pause_reason: "norma_call" });
    expect(await count("lead_events", ctx.id, "norma_call_attempt_no_answer")).toBe(1);
    expect(await count("lead_events", ctx.id, "norma_call_completed")).toBe(0);
    // This checks the production attempt-aware reconciliation grace.
    // Direct legacy SQL caller hazards remain separately asserted below.
  });
});


describe("negative SQL compatibility evidence: legacy callers remain unfenced", () => {
  it("defaulted claim takes attempt 2 and metadata-less result can complete it before bind", async () => {
    const ctx = await dispatched();
    await complete(ctx.id, `first_${ctx.id}`, "no_answer", 1);
    expect(await claim(ctx.id, 1)).toBe(false);
    expect((await q("select public.fn_norma_claim_dispatch($1) as claimed", [ctx.id]))[0]!.claimed).toBe(true);
    expect(await row(ctx.id)).toMatchObject({ status: "dispatching", attempt: 2, bland_call_id: null });
    expect(await complete(ctx.id, "forged_legacy_id", "no_answer", 1)).toMatchObject({ result: "stale_attempt" });
    const result = (await q("select public.fn_norma_complete_call($1,$2,$3,'{}'::jsonb) as result", [ctx.id, "forged_legacy_id", "no_answer"]))[0]!.result;
    expect(result).toMatchObject({ result: "applied", status: "completed" });
    expect(await row(ctx.id)).toMatchObject({ attempt: 2, status: "completed", bland_call_id: "forged_legacy_id" });
    expect(await count("norma_notifications", ctx.id)).toBe(1);
    // A passing receipt proves the hazard, not safe mixed-version operation.
  });
});
