import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimNormaDispatch } from "../rpc";
import { handleBlandCallWebhook } from "../webhook";
import { WEBHOOK_SECRET } from "./fake-bland";
import { Harness } from "./harness";
import { checkInvariants } from "./invariants";
import { Barrier, Latch, rng } from "./trace";

/**
 * Call twice (Jarrad, 2026-10-02): a confirmed non-connect on the first call
 * places exactly one retry, through the ordinary dispatch path. Forced
 * scenarios; the randomised gate mixes the same behaviour with every fault.
 * Invariant [1] (at most two Bland calls per request, the second only after a
 * confirmed non-connect of the first) is checked over everything at the end.
 */
let h: Harness;
beforeAll(async () => {
  h = await Harness.create(rng(21));
});
afterAll(async () => {
  await h?.close();
});

const q = async (sql: string, params: unknown[] = []) => (await h.scratch.pool.query(sql, params)).rows;
const requestOf = async (property: string) =>
  (await q("select * from public.norma_call_requests where property_id = $1 order by created_at desc limit 1", [property]))[0];
const enrollment = async (id: string) => (await q("select status, pause_reason from public.sequence_enrollments where id = $1", [id]))[0];
const countOf = async (sql: string, params: unknown[]) => Number((await q(sql, params))[0].n);
const events = (requestId: string, type: string) =>
  countOf("select count(*) as n from public.lead_events where event_type = $1 and source_id = $2", [type, requestId]);
const tasksOf = async (requestId: string) => q("select * from public.tasks where source_key = $1", [`norma_call:${requestId}`]);

async function place(kind: "voicemail" | "no_answer_status", extra: Parameters<Harness["lead"]>[1] = {}, enrollments: ("active" | "paused:call_in_progress")[] = ["active"]) {
  const ctx = await h.lead({ enrollments }, { kind, ...extra });
  const res = await h.requestCall(ctx, h.world.rep1);
  expect(res).toMatchObject({ ok: true, code: "calling" });
  return ctx;
}

describe.each(["voicemail", "no_answer_status"] as const)("first call not answered (%s)", (kind) => {
  it("places exactly one second call, same request, drip held across both, released only after the second miss", async () => {
    const ctx = await place(kind);
    const [first] = h.bland.callsForNumber(ctx.lead.phone);
    const hook = await h.bland.webhook(first!, "good");
    expect(hook.body).toMatchObject({ status: "applied", retry: "dispatched" });
    const request = await requestOf(ctx.lead.property);
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(2);
    expect(h.bland.sendsFor(request.id)).toHaveLength(2);
    expect(request).toMatchObject({ status: "dispatched", attempt: 2, first_bland_call_id: first!.callId });
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
    expect(await events(request.id, "norma_call_completed")).toBe(0);

    const second = h.bland.callsForNumber(ctx.lead.phone)[1]!;
    expect((await h.bland.webhook(second, "good")).body.status).toBe("applied");
    const done = await requestOf(ctx.lead.property);
    expect(done).toMatchObject({ status: "completed", outcome: "no_answer", attempt: 2, bland_call_id: second.callId });
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "active", pause_reason: null });
    expect(await events(request.id, "norma_call_completed")).toBe(1);
    expect(await tasksOf(request.id)).toHaveLength(0);
  });

  it("replay storm of the first call's webhook (parallel, before and after the retry) never makes a third call", async () => {
    const ctx = await place(kind);
    const first = h.bland.callsForNumber(ctx.lead.phone)[0]!;
    const results = await Promise.all(Array.from({ length: 8 }, () => h.bland.webhook(first, "good")));
    expect(results.every((r) => r.status === 200)).toBe(true);
    // Exactly one delivery applied (and dialled the retry); every other was a replay.
    expect(results.filter((r) => r.body.status === "applied")).toHaveLength(1);
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(2);
    const second = h.bland.callsForNumber(ctx.lead.phone)[1]!;
    await Promise.all([...Array.from({ length: 4 }, () => h.bland.webhook(first, "good")), ...Array.from({ length: 4 }, () => h.bland.webhook(second, "good"))]);
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(2);
    const request = await requestOf(ctx.lead.property);
    expect(request).toMatchObject({ status: "completed", attempt: 2 });
    expect(await events(request.id, "norma_call_completed")).toBe(1);
    expect(await events(request.id, "norma_call_attempt_no_answer")).toBe(1);
  });

  it("webhook and reconciliation both finding the miss together: one retry, one second call", async () => {
    const ctx = await place(kind);
    const request = await requestOf(ctx.lead.property);
    await h.advance(4 * 60_000);
    const barrier = new Barrier(2);
    const remove = h.addHook(async (info) => {
      if (info.kind === "rpc" && info.name === "fn_norma_complete_call" && ["webhook", "reconcile-race"].includes(info.actor) &&
          (info.args as { p_request_id?: string } | undefined)?.p_request_id === request.id) await barrier.wait();
    });
    await Promise.all([h.bland.webhook(h.bland.callsForNumber(ctx.lead.phone)[0]!, "good"), h.reconcile({ actor: "reconcile-race" })]);
    remove();
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(2);
    expect(h.bland.sendsFor(request.id)).toHaveLength(2);
    expect(await events(request.id, "norma_call_attempt_no_answer")).toBe(1);
  });

  it("process dies after scheduling the retry: the sweep dials it once, a second sweep does not dial again", async () => {
    const ctx = await place(kind);
    const request = await requestOf(ctx.lead.property);
    // Webhook whose retry dispatch is lost: simulate by completing through the RPC path only.
    const first = h.bland.callsForNumber(ctx.lead.phone)[0]!;
    h.skipRetryDispatchOnce = true;
    await h.bland.webhook(first, "good");
    expect(await requestOf(ctx.lead.property)).toMatchObject({ status: "requested", attempt: 2 });
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(1);
    await h.advance(2 * 60_000);
    await h.reconcile();
    await h.reconcile();
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(2);
    expect(h.bland.sendsFor(request.id)).toHaveLength(2);
  });

  it("a retry nobody dials within the expiry is closed, never dialled late; pauses released, first call on record", async () => {
    const ctx = await place(kind);
    const request = await requestOf(ctx.lead.property);
    h.skipRetryDispatchOnce = true;
    await h.bland.webhook(h.bland.callsForNumber(ctx.lead.phone)[0]!, "good");
    await h.advance(10 * 60_000);
    await h.reconcile();
    expect(await requestOf(ctx.lead.property)).toMatchObject({ status: "dispatch_rejected", attempt: 2 });
    expect(h.bland.sendsFor(request.id)).toHaveLength(1);
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "active", pause_reason: null });
  });
});

describe("malformed attempt metadata cannot overflow the completion SQL", () => {
  it.each([99_999_999_999, "99999999999"])("acknowledges oversized attempt %s without changing either call", async (attempt) => {
    const ctx = await place("voicemail");
    for (const currentAttempt of [1, 2]) {
      const current = h.bland.callsForNumber(ctx.lead.phone)[currentAttempt - 1]!;
      const payload = h.bland.payload(current);
      payload.metadata = { request_id: current.requestId, idempotency_key: current.key, attempt };
      const body = JSON.stringify(payload);
      const response = await handleBlandCallWebhook(new Request("http://stress.local/api/webhooks/bland/call", {
        method: "POST", body,
        headers: { "x-webhook-signature": createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex") },
      }), { client: h.client("oversized-attempt"), secret: WEBHOOK_SECRET });
      expect(response).toEqual({ status: 200, body: { status: "ignored", reason: "stale_attempt" } });
      const request = await requestOf(ctx.lead.property);
      expect(request).toMatchObject({ status: "dispatched", attempt: currentAttempt, outcome: null });
      expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(currentAttempt);
      expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect(await events(request.id, "norma_call_completed")).toBe(0);
      expect(await tasksOf(request.id)).toHaveLength(0);
      await h.bland.webhook(current, "good");
    }
    expect(await requestOf(ctx.lead.property)).toMatchObject({ status: "completed", outcome: "no_answer", attempt: 2 });
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "active", pause_reason: null });
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(2);
  });
});

describe("only the current attempt can complete or advance the request", () => {
  it("a stale/forged attempt-1 id while attempt 2 is claimed but unbound is a no-op: no completion, no release, no task, no Slack row, no extra call", async () => {
    const ctx = await place("voicemail", { secondKind: "callback" });
    const request = await requestOf(ctx.lead.property);
    h.skipRetryDispatchOnce = true;
    const first = h.bland.callsForNumber(ctx.lead.phone)[0]!;
    await h.bland.webhook(first, "good");
    // Attempt 2 claimed (dispatching) but its call id is not bound yet.
    expect(await claimNormaDispatch(h.client("claim"), request.id, 2)).toBe(true);
    expect(await requestOf(ctx.lead.property)).toMatchObject({ status: "dispatching", attempt: 2, bland_call_id: null });
    for (const flavor of ["mismatch_call_id", "good"] as const) {
      const hook = await h.bland.webhook(first, flavor);
      expect(hook.status).toBe(200);
      expect(hook.body.status).not.toBe("applied");
    }
    expect(await requestOf(ctx.lead.property)).toMatchObject({ status: "dispatching", attempt: 2, bland_call_id: null, outcome: null });
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
    expect(await events(request.id, "norma_call_completed")).toBe(0);
    expect(await countOf("select count(*) as n from public.norma_notifications where request_id = $1", [request.id])).toBe(0);
    expect(await tasksOf(request.id)).toHaveLength(0);
    expect(h.bland.sendsFor(request.id)).toHaveLength(1);
  });
});

describe("the retry goes through every gate again", () => {
  it("DNC landing between the calls: the retry is refused at the dial-time recheck, nothing is dialled", async () => {
    const ctx = await place("voicemail");
    await h.dnc(ctx, "registry");
    const hook = await h.bland.webhook(h.bland.callsForNumber(ctx.lead.phone)[0]!, "good");
    expect(hook.status).toBe(200);
    const request = await requestOf(ctx.lead.property);
    expect(request.status).toBe("dispatch_rejected");
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(1);
    expect(h.bland.sendsFor(request.id)).toHaveLength(1);
  });

  it("seller marked not_interested between the calls: no second call", async () => {
    const ctx = await place("no_answer_status");
    await h.notInterested(ctx);
    await h.bland.webhook(h.bland.callsForNumber(ctx.lead.phone)[0]!, "good");
    expect((await requestOf(ctx.lead.property)).status).toBe("dispatch_rejected");
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(1);
  });

  it("dispatch gate closed between the calls: no second call", async () => {
    const ctx = await place("voicemail");
    ctx.dispatchGate = "disabled";
    await h.bland.webhook(h.bland.callsForNumber(ctx.lead.phone)[0]!, "good");
    expect((await requestOf(ctx.lead.property)).status).toBe("dispatch_rejected");
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(1);
    ctx.dispatchGate = "open";
  });

  it("seller replied during the hold: still called again, drip stays paused as the reply", async () => {
    const ctx = await place("voicemail");
    await h.inboundReply(ctx);
    await h.finish(ctx);
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(2);
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
  });
});

describe("never retried unless the first call is a confirmed non-connect", () => {
  it.each(["callback", "reached", "not_interested", "wrong_number"] as const)("%s on the first call completes with a single call", async (kind) => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind });
    await h.requestCall(ctx, h.world.rep1);
    const hook = await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good");
    expect(hook.body).toEqual({ status: "applied" });
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(1);
    expect(await requestOf(ctx.lead.property)).toMatchObject({ status: "completed", attempt: 1 });
  });

  it("an unconfirmed first call (send timed out, then nothing) is parked, never redialled", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "voicemail", send: "accept_timeout" });
    await h.requestCall(ctx, h.world.rep1);
    expect((await requestOf(ctx.lead.property)).status).toBe("dispatch_unknown");
    await h.advance(11 * 60_000);
    await h.reconcile();
    await h.reconcile();
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(1);
    // A late no-answer result for it completes plainly: no retry now.
    await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good");
    const request = await requestOf(ctx.lead.property);
    expect(request).toMatchObject({ status: "completed", outcome: "no_answer", attempt: 1 });
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(1);
  });

  it("the second call answered by a person completes normally with its task; the drip stays paused", async () => {
    const ctx = await place("voicemail", { secondKind: "callback" });
    await h.finish(ctx);
    const request = await requestOf(ctx.lead.property);
    expect(request).toMatchObject({ status: "completed", outcome: "callback_requested", attempt: 2 });
    expect(await tasksOf(request.id)).toHaveLength(1);
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
  });
});

describe("invariants over everything above", () => {
  it("zero violations", async () => {
    await h.recover({ horizonMs: 3 * 3600_000 });
    const { violations } = await checkInvariants(h, { settled: true });
    expect(violations).toEqual([]);
  });
});

describe("STOP prevents the next call", () => {
  const sent = (ctx: Awaited<ReturnType<typeof place>>, onSend: () => Promise<void>) => ({
    enabled: true,
    send: async () => {
      await onSend();
      return { status: "sent", messageId: "m", externalId: "e" } as never;
    },
  });

  it("STOP replied to the pre-call text, before attempt 1: nothing is dialled, the request ends rejected, the drip is not resumed", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback" });
    let texts = 0;
    h.precallSms = sent(ctx as never, async () => {
      texts += 1;
      await h.stop(ctx);
    });
    try {
      await h.requestCall(ctx, h.world.rep1);
    } finally {
      h.precallSms = undefined;
    }
    const request = await requestOf(ctx.lead.property);
    expect(texts).toBe(1);
    expect(request.status).toBe("dispatch_rejected");
    expect(request.dispatch_error).toContain("sms_opted_out");
    expect(h.bland.sendsFor(request.id)).toHaveLength(0);
    expect((await enrollment(ctx.lead.enrollments[0]!)).status).not.toBe("active");
  });

  it("STOP between attempts: the retry is refused at the dial-time recheck, one call only", async () => {
    const ctx = await place("voicemail");
    await h.stop(ctx);
    await h.bland.webhook(h.bland.callsForNumber(ctx.lead.phone)[0]!, "good");
    const request = await requestOf(ctx.lead.property);
    expect(request.status).toBe("dispatch_rejected");
    expect(h.bland.sendsFor(request.id)).toHaveLength(1);
    expect((await enrollment(ctx.lead.enrollments[0]!)).status).not.toBe("active");
  });

  it.each(["contact flag", "phone suppression", "opted_out disposition"] as const)("each STOP record alone blocks the retry (%s)", async (how) => {
    const ctx = await place("no_answer_status");
    if (how === "contact flag") await q("update public.contacts set sms_opted_out = true where id = $1", [ctx.lead.contact]);
    else if (how === "phone suppression") await q("insert into public.sms_phone_suppressions (org_id, channel, phone_e164, source) values ($1,'sms',$2,'t')", [h.world.org, ctx.lead.phone]);
    else await q("update public.properties set outreach_dispo = 'opted_out' where id = $1", [ctx.lead.property]);
    await h.bland.webhook(h.bland.callsForNumber(ctx.lead.phone)[0]!, "good");
    expect((await requestOf(ctx.lead.property)).status).toBe("dispatch_rejected");
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(1);
  });
});

describe("the final pre-send fence cannot dial after review wins", () => {
  async function parkBeforeFence(attempt: 1 | 2) {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "voicemail", secondKind: "callback" });
    let requestId: string;
    if (attempt === 1) {
      await h.requestCall(ctx, h.world.rep1, { crashBeforeDispatch: true });
      requestId = (await requestOf(ctx.lead.property)).id;
    } else {
      await h.requestCall(ctx, h.world.rep1);
      h.skipRetryDispatchOnce = true;
      await h.bland.webhook(h.bland.callsForNumber(ctx.lead.phone)[0]!, "good");
      const row = await requestOf(ctx.lead.property);
      expect(row).toMatchObject({ status: "requested", attempt: 2 });
      requestId = row.id;
    }
    const gate = new Latch();
    const reached = new Latch();
    const remove = h.holdOnce(
      (info) => info.kind === "rpc" && info.name === "fn_norma_presend_fence" && info.actor === `presend-${attempt}` && (info.args as { p_request_id?: string } | undefined)?.p_request_id === requestId,
      gate.promise,
      () => reached.open(),
    );
    try {
      const dispatching = h.dispatch(requestId, `presend-${attempt}`);
      await reached.promise;
      expect(await requestOf(ctx.lead.property)).toMatchObject({ status: "dispatching", attempt });
      expect((await h.scratch.pool.query("select public.fn_norma_mark_needs_review($1,$2,$3) as result", [requestId, "presend-race", attempt])).rows[0].result).toBe("needs_review");
      expect(await h.markReviewed(ctx, h.world.rep1)).toMatchObject({ ok: true, code: "reviewed" });
      gate.open();
      expect(await dispatching).toMatchObject({ status: "not_claimed" });
    } finally {
      remove();
      gate.open();
    }
    expect(h.bland.sendsFor(requestId)).toHaveLength(attempt === 1 ? 0 : 1);
    expect(await requestOf(ctx.lead.property)).toMatchObject({ status: "completed", outcome: "reviewed", attempt });
    expect(await events(requestId, "norma_call_completed")).toBe(0);
    expect(await events(requestId, "norma_call_reviewed")).toBe(1);
    return ctx;
  }

  it.each([1, 2] as const)("attempt %s: claim then review before the fence release sends no call", async (attempt) => {
    await parkBeforeFence(attempt);
  });

  it("a fence that starts after review commits is safely refused without a false invariant", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback" });
    await h.requestCall(ctx, h.world.rep1, { crashBeforeDispatch: true });
    const id = (await requestOf(ctx.lead.property)).id;
    const gate = new Latch();
    const reached = new Latch();
    const remove = h.holdOnce(
      (info) => info.kind === "rpc" && info.name === "fn_norma_eligibility" && info.actor === "post-review-fence",
      gate.promise,
      () => reached.open(),
    );
    try {
      const dispatching = h.dispatch(id, "post-review-fence");
      await reached.promise;
      expect((await requestOf(ctx.lead.property)).status).toBe("dispatching");
      expect((await h.scratch.pool.query("select public.fn_norma_mark_needs_review($1,$2,$3) as result", [id, "post-review-fence", 1])).rows[0].result).toBe("needs_review");
      expect(await h.markReviewed(ctx, h.world.rep1)).toMatchObject({ ok: true, code: "reviewed" });
      gate.open();
      expect(await dispatching).toMatchObject({ status: "not_claimed" });
    } finally {
      remove();
      gate.open();
    }
    expect(h.bland.sendsFor(id)).toHaveLength(0);
    const { violations } = await checkInvariants(h, { settled: false });
    expect(violations.filter((v) => v.includes(id))).toEqual([]);
  });

  it("positive control: an ordinary fresh dispatch still sends one call", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback" });
    await h.requestCall(ctx, h.world.rep1);
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(1);
    expect((await requestOf(ctx.lead.property)).status).toBe("dispatched");
  });
});

describe("a stalled dispatcher cannot act for the wrong attempt", () => {
  it("worker A (attempt-1 snapshot) stalls before its claim; B finishes attempt 1; A wakes: no second text, retry carries attempt 2", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "voicemail", secondKind: "callback" });
    await h.requestCall(ctx, h.world.rep1, { actor: "press", crashBeforeDispatch: true });
    const request = await requestOf(ctx.lead.property);
    let texts = 0;
    h.precallSms = { enabled: true, send: async () => { texts += 1; return { status: "sent", messageId: "m", externalId: "e" } as never; } };
    const gate = new Latch();
    const reached = new Latch();
    const remove = h.holdOnce(
      (info) => info.kind === "rpc" && info.name === "fn_norma_claim_dispatch" && info.actor === "worker-A",
      gate.promise,
      () => reached.open(),
    );
    try {
      const a = h.dispatch(request.id, "worker-A");
      await reached.promise;
      // B takes attempt 1 all the way: text, call 1, its no-answer webhook schedules the retry (not yet dialled).
      expect(await h.dispatch(request.id, "worker-B")).toMatchObject({ status: "dispatched" });
      h.skipRetryDispatchOnce = true;
      await h.bland.webhook(h.bland.callsForNumber(ctx.lead.phone)[0]!, "good");
      expect(await requestOf(ctx.lead.property)).toMatchObject({ status: "requested", attempt: 2 });
      gate.open();
      expect(await a).toEqual({ status: "not_claimed" });
    } finally {
      remove();
      h.precallSms = undefined;
    }
    expect(texts).toBe(1);
    expect(h.bland.sendsFor(request.id)).toHaveLength(1);
    // The real retry dispatch: attempt 2, and still no text.
    h.precallSms = { enabled: true, send: async () => { texts += 1; return { status: "sent", messageId: "m", externalId: "e" } as never; } };
    await h.dispatch(request.id, "worker-C");
    h.precallSms = undefined;
    expect(texts).toBe(1);
    expect(h.bland.sendsFor(request.id).map((s) => s.attempt)).toEqual([1, 2]);
  });
});
