import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Harness, type LeadCtx } from "./harness";
import { checkInvariants } from "./invariants";
import { rng, sleep } from "./trace";

/**
 * "Mark reviewed" end to end on a real scratch database: the real action core,
 * the real webhook, the real reconcile sweep. Deterministic scenes for the
 * races the random run only meets by chance.
 */
let h: Harness;
beforeAll(async () => {
  h = await Harness.create(rng(321));
});
afterAll(async () => {
  await h?.close();
});

const q = async (sql: string, params: unknown[] = []) => (await h.scratch.pool.query(sql, params)).rows;
const requests = (property: string) => q("select * from public.norma_call_requests where property_id = $1 order by created_at", [property]);
const requestOf = async (property: string) => (await requests(property)).at(-1);
const tasksOf = (requestId: string) => q("select id, status, title, completed_by from public.tasks where source_key = $1", [`norma_call:${requestId}`]);
const enrollment = async (id: string) => (await q("select status, pause_reason from public.sequence_enrollments where id = $1", [id]))[0];
const events = (requestId: string, type: string) => q("select id from public.lead_events where event_type = $1 and payload->>'request_id' = $2", [type, requestId]);

/** A call whose send timed out and was never confirmed: after the sweep it is parked for review with its task. */
/** Build an attempt-2 request whose bound second call has aged into needs_review. */
async function parkedAttemptTwoLead(): Promise<{ ctx: LeadCtx; requestId: string; secondCall: NonNullable<ReturnType<Harness["bland"]["callForNumber"]>> }> {
  const ctx = await h.lead({ enrollments: ["active"] }, { kind: "voicemail", secondKind: "callback", lookup: "not_completed" });
  await h.requestCall(ctx, h.world.rep1);
  const first = h.bland.callForNumber(ctx.lead.phone)!;
  expect((await h.bland.webhook(first, "good")).body).toMatchObject({ status: "applied", retry: "dispatched" });
  const second = h.bland.callsForNumber(ctx.lead.phone)[1]!;
  await h.advance(61 * 60_000);
  await h.reconcile();
  const row = (await requestOf(ctx.lead.property))!;
  expect(row).toMatchObject({ status: "needs_review", attempt: 2, bland_call_id: second.callId });
  return { ctx, requestId: row.id, secondCall: second };
}

/** Confirm a real competing RPC is waiting on the request row lock before the winner commits. */
async function waitForRpcLock(fragment: string, requestId: string) {
  for (let i = 0; i < 200; i += 1) {
    const rows = await q(
      `select 1 from pg_stat_activity
       where datname = current_database() and pid <> pg_backend_pid()
         and wait_event_type = 'Lock' and query like $1`,
      [`%${fragment}%`],
    );
    if (rows.length > 0) return;
    await sleep(5);
  }
  throw new Error(`expected ${fragment} for ${requestId} to wait on a row lock`);
}

async function parkedLead(opts: { enrollments?: ("active" | "paused:call_in_progress")[]; kind?: "callback" | "no_answer_status" | "not_interested" } = {}): Promise<LeadCtx> {
  const ctx = await h.lead({ enrollments: opts.enrollments ?? ["active"] }, { kind: opts.kind ?? "callback", send: "accept_timeout" });
  await h.requestCall(ctx, h.world.rep1);
  await h.advance(11 * 60_000);
  await h.reconcile();
  expect((await requestOf(ctx.lead.property))!.status).toBe("needs_review");
  return ctx;
}

/** Every invariant that applies to a scene (the Slack outbox drains on its own clock, so [8] and [7] are left to the random run). */
async function expectClean(ctx?: LeadCtx) {
  await h.slackDrain();
  const { violations } = await checkInvariants(h, { settled: false });
  const relevant = violations.filter((x) => !x.startsWith("[8]"));
  expect(relevant, ctx ? `lead ${ctx.lead.property}` : undefined).toEqual([]);
}

describe("mark reviewed (stress scenes)", () => {
  it("clears the stuck lead: reviewed, task closed, drip still paused, nothing dialled, one event", async () => {
    const ctx = await parkedLead();
    const parked = (await requestOf(ctx.lead.property))!;
    expect(await h.requestCall(ctx, h.world.rep2)).toMatchObject({ ok: false, code: "in_flight" });
    const sendsBefore = h.bland.sends.length;

    expect(await h.markReviewed(ctx, h.world.rep2)).toEqual({ ok: true, code: "reviewed" });

    const done = (await requestOf(ctx.lead.property))!;
    expect(done).toMatchObject({ status: "completed", outcome: "reviewed", reviewed_by: h.world.rep2 });
    expect(await tasksOf(parked.id)).toEqual([expect.objectContaining({ status: "completed", completed_by: h.world.rep2 })]);
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
    expect(await events(parked.id, "norma_call_reviewed")).toHaveLength(1);
    // Workers running for hours afterwards never resume the drip or place a call on their own.
    await h.recover({ horizonMs: 3 * 3600_000 });
    expect(h.bland.sends.length).toBe(sendsBefore);
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
    expect(await requests(ctx.lead.property)).toHaveLength(1);
    await expectClean(ctx);
  });

  it("afterwards a new Norma call is allowed, dials once, and its own result applies", async () => {
    const ctx = await parkedLead();
    const first = (await requestOf(ctx.lead.property))!;
    await h.markReviewed(ctx, h.world.rep1);
    // The provider behaves this time.
    ctx.plan.send = "accept";
    ctx.plan.kind = "callback";
    await h.advance(15_000); // (margin for host↔DB clock drift) claim_dispatch_v2 spaces dials on one number by 10 s [C9]; the first send was just now

    expect(await h.requestCall(ctx, h.world.rep2)).toMatchObject({ ok: true, code: "calling" });
    const rows = await requests(ctx.lead.property);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: first.id, status: "completed", outcome: "reviewed" });
    expect(h.bland.sendsFor(first.id)).toHaveLength(1);
    expect(h.bland.sendsFor(rows[1]!.id)).toHaveLength(1);
    // A second request is still fenced while this one is open.
    expect(await h.requestCall(ctx, h.world.rep1)).toMatchObject({ ok: false, code: "in_flight" });

    const call = h.bland.callsForNumber(ctx.lead.phone).find((c) => c.requestId === rows[1]!.id)!;
    expect((await h.bland.webhook(call, "good")).body.status).toBe("applied");
    expect(await requestOf(ctx.lead.property)).toMatchObject({ status: "completed", outcome: "callback_requested" });
    expect(await tasksOf(rows[1]!.id)).toEqual([expect.objectContaining({ status: "open" })]);
    // The reviewed request and its closed task are untouched by the new call.
    expect(await tasksOf(first.id)).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(await q("select outcome from public.norma_call_requests where id = $1", [first.id])).toEqual([{ outcome: "reviewed" }]);
    await expectClean(ctx);
  });

  it("a stranger is refused and nothing changes; a member's replays after the first are quiet successes", async () => {
    const ctx = await parkedLead();
    const parked = (await requestOf(ctx.lead.property))!;
    expect(await h.markReviewed(ctx, h.world.outsider)).toEqual({ ok: false, code: "not_authorized" });
    expect((await requestOf(ctx.lead.property))!.status).toBe("needs_review");
    expect(await h.markReviewed(ctx, h.world.rep1)).toEqual({ ok: true, code: "reviewed" });
    const stamped = (await requestOf(ctx.lead.property))!;
    expect(await h.markReviewed(ctx, h.world.rep2)).toEqual({ ok: true, code: "already_reviewed" });
    expect(await h.markReviewed(ctx, h.world.rep1)).toEqual({ ok: true, code: "already_reviewed" });
    expect((await requestOf(ctx.lead.property))!.reviewed_at).toEqual(stamped.reviewed_at);
    expect((await requestOf(ctx.lead.property))!.reviewed_by).toBe(h.world.rep1);
    expect(await events(parked.id, "norma_call_reviewed")).toHaveLength(1);
    await expectClean(ctx);
  });

  it("a request that is not parked cannot be reviewed", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback" });
    expect(await h.markReviewed(ctx, h.world.rep1)).toBeNull();
    await h.requestCall(ctx, h.world.rep1);
    expect(await h.markReviewed(ctx, h.world.rep1)).toMatchObject({ ok: false, code: "not_waiting" });
    expect((await requestOf(ctx.lead.property))!).toMatchObject({ status: "dispatched", outcome: null, reviewed_by: null });
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
    await h.finish(ctx);
    expect(await h.markReviewed(ctx, h.world.rep1)).toMatchObject({ ok: false, code: "not_waiting", status: "completed" });
    expect((await requestOf(ctx.lead.property))!.outcome).toBe("callback_requested");
    await expectClean(ctx);
  });

  it("a softphone pause that appeared while the call was parked is held, not resumed", async () => {
    const ctx = await parkedLead({ enrollments: ["active"] });
    await h.softphonePause(ctx);
    await h.markReviewed(ctx, h.world.rep1);
    await h.softphoneCleanup(ctx);
    await h.staleSweep();
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
    await expectClean(ctx);
  });

  it("do-not-contact lead: the review still lands, the task stays as it was, the drip stays opted out", async () => {
    const ctx = await parkedLead();
    const parked = (await requestOf(ctx.lead.property))!;
    await h.dnc(ctx, "lock");
    expect(await h.markReviewed(ctx, h.world.rep1)).toEqual({ ok: true, code: "reviewed" });
    expect((await requestOf(ctx.lead.property))!).toMatchObject({ status: "completed", outcome: "reviewed" });
    expect(await tasksOf(parked.id)).toEqual([expect.objectContaining({ status: "open" })]);
    // And the lead cannot be called again.
    expect(await h.requestCall(ctx, h.world.rep1)).toMatchObject({ ok: false, code: "blocked" });
    await expectClean(ctx);
  });

  it("attempt-2 review wins after the late callback is provably waiting: no completion or resume", async () => {
    const { ctx, requestId, secondCall } = await parkedAttemptTwoLead();
    const holder = await h.scratch.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from public.norma_call_requests where id = $1 for update", [requestId]);
      const late = h.bland.webhook(secondCall, "good");
      await waitForRpcLock("fn_norma_complete_call", requestId);
      const review = await holder.query<{ result: unknown }>(
        "select public.fn_norma_mark_reviewed($1, $2, $3) as result",
        [requestId, ctx.lead.property, h.world.rep1],
      );
      expect(review.rows[0]?.result).toMatchObject({ result: "reviewed", status: "completed", task_closed: true });
      // This winner runs the same service RPC on the lock-owning connection; register the
      // equivalent action-core observation so the shared stress invariants see the press.
      const reviewTick = h.trace.add("review-holder", "start", "rpc:fn_norma_mark_reviewed");
      h.reviews.push({ requestId, propertyId: ctx.lead.property, user: h.world.rep1, actor: "review-holder", startTick: reviewTick, endTick: h.trace.tick(), result: { ok: true, code: "reviewed" } });
      await holder.query("commit");
      const lateResult = await late;
      expect(lateResult.status).toBe(200);
      expect((await requestOf(ctx.lead.property))!).toMatchObject({ status: "completed", attempt: 2, outcome: "reviewed" });
      expect(await events(requestId, "norma_call_reviewed")).toHaveLength(1);
      expect(await events(requestId, "norma_call_completed")).toHaveLength(0);
      expect(await tasksOf(requestId)).toEqual([expect.objectContaining({ status: "completed" })]);
      expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect(await q("select id from public.norma_notifications where request_id = $1 order by id", [requestId])).toHaveLength(0);
      const release = await h.scratch.pool.query("select public.fn_norma_release_pauses($1) as result", [requestId]);
      expect(release.rows[0]?.result).toBe(0);
      expect(await h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(2);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  });

  it("attempt-2 callback wins after the review is provably waiting: review is invalid and callback side effects occur once", async () => {
    const { ctx, requestId, secondCall } = await parkedAttemptTwoLead();
    const holder = await h.scratch.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from public.norma_call_requests where id = $1 for update", [requestId]);
      const lateReview = h.markReviewed(ctx, h.world.rep1);
      await waitForRpcLock("fn_norma_mark_reviewed", requestId);
      const complete = await holder.query<{ result: unknown }>(
        "select public.fn_norma_complete_call($1, $2, $3, $4::jsonb) as result",
        [requestId, secondCall.callId, "callback_requested", JSON.stringify({ attempt: "2" })],
      );
      expect(complete.rows[0]?.result).toMatchObject({ result: "applied", status: "completed", outcome: "callback_requested" });
      await holder.query("commit");
      const lateResult = await lateReview;
      expect(lateResult).toMatchObject({ ok: false, code: "not_waiting", status: "completed" });
      expect((await requestOf(ctx.lead.property))!).toMatchObject({ status: "completed", attempt: 2, outcome: "callback_requested" });
      expect(await events(requestId, "norma_call_completed")).toHaveLength(1);
      expect(await events(requestId, "norma_call_reviewed")).toHaveLength(0);
      expect(await q("select id from public.norma_notifications where request_id = $1 order by id", [requestId])).toHaveLength(1);
      expect(await tasksOf(requestId)).toEqual([expect.objectContaining({ status: "open" })]);
      expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect(await h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(2);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  });

  it("races: double clicks against the real result arriving, and against the sweep and other workers", async () => {
    let reviewedWins = 0;
    let resultWins = 0;
    for (let round = 0; round < 8; round += 1) {
      const ctx = await parkedLead({ enrollments: round % 2 ? ["active"] : ["paused:call_in_progress"] });
      const call = h.bland.callForNumber(ctx.lead.phone)!;
      const clicks = Array.from({ length: 4 }, (_, i) => h.markReviewed(ctx, i % 2 ? h.world.rep1 : h.world.rep2));
      const jobs = [h.bland.webhook(call, "good"), h.reconcile({ includeNeedsReview: true, actor: `reconcile-${round}` }), h.staleSweep(`sweep-${round}`), h.inboundReply(ctx, `reply-${round}`)];
      const results = (await Promise.all([...clicks, ...jobs])).slice(0, clicks.length) as Awaited<ReturnType<typeof h.markReviewed>>[];

      const row = (await requestOf(ctx.lead.property))!;
      expect(row.status).toBe("completed");
      const applied = results.filter((r) => r?.ok && r.code === "reviewed");
      if (row.outcome === "reviewed") {
        reviewedWins += 1;
        expect(applied).toHaveLength(1);
        // The late result is then a no-op: it must not rewrite the outcome or reopen the task.
        expect((await tasksOf(row.id)).every((t) => t.status === "completed")).toBe(true);
      } else {
        resultWins += 1;
        expect(applied).toHaveLength(0);
        expect(results.filter((r) => r?.ok)).toHaveLength(0);
      }
      expect(await events(row.id, "norma_call_reviewed")).toHaveLength(row.outcome === "reviewed" ? 1 : 0);
      expect(await events(row.id, "norma_call_completed")).toHaveLength(row.outcome === "reviewed" ? 0 : 1);
      expect(await requests(ctx.lead.property)).toHaveLength(1);
    }
    // Both orders are legal and either may win a given round; the point is that neither corrupts the other.
    console.log(`[norma-stress] mark-reviewed races: reviewed won ${reviewedWins}, the call result won ${resultWins}`);
    expect(reviewedWins + resultWins).toBe(8);
    await expectClean();
  });
});
