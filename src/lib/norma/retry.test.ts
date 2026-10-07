import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { reconcileNormaCalls } from "./reconcile";
import { dispatchScheduledRetry } from "./retry";
import { fakeClient, KEY, PHONE, REQUEST_ID, requestRow } from "./test-helpers";
import { handleBlandCallWebhook } from "./webhook";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const RETRY = { result: "applied", status: "requested", outcome: "no_answer", retry: true } as const;

describe("dispatchScheduledRetry", () => {
  it("dispatches exactly when the completion scheduled the retry", async () => {
    const dispatch = vi.fn().mockResolvedValue({ status: "dispatched", callId: "c2" });
    expect(await dispatchScheduledRetry(RETRY, REQUEST_ID, dispatch)).toEqual({ status: "dispatched", callId: "c2" });
    expect(dispatch).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("never dispatches for a replay, a final completion, a review, a mismatch, or with no dispatcher", async () => {
    const dispatch = vi.fn();
    for (const result of [
      { result: "replayed", status: "requested", outcome: "no_answer" },
      { result: "applied", status: "completed", outcome: "no_answer" },
      { result: "applied", status: "completed", outcome: "callback_requested" },
      { result: "applied", status: "needs_review", outcome: "unknown" },
      { result: "call_id_mismatch", status: "dispatched" },
    ] as const) {
      expect(await dispatchScheduledRetry(result, REQUEST_ID, dispatch)).toBeNull();
    }
    expect(await dispatchScheduledRetry(RETRY, REQUEST_ID, undefined)).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a throwing dispatcher is swallowed: the request stays requested for the sweep", async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error("bland down"));
    expect(await dispatchScheduledRetry(RETRY, REQUEST_ID, dispatch)).toBeNull();
  });
});

const SECRET = "whsec_test";
const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");
const noAnswerCall = (callId: string) => ({
  call_id: callId, to: PHONE, completed: true, status: "no-answer", answered_by: "no-answer",
  metadata: { request_id: REQUEST_ID, idempotency_key: KEY }, variables: {},
});

describe("webhook: call twice", () => {
  function setup(results: unknown[]) {
    const complete = vi.fn();
    for (const r of results) complete.mockReturnValueOnce(r);
    const { client } = fakeClient({ norma_call_requests: [requestRow({ status: "dispatched" })] }, { fn_norma_complete_call: complete });
    const dispatch = vi.fn().mockResolvedValue({ status: "dispatched", callId: "c2" });
    const post = (payload: unknown) => {
      const body = JSON.stringify(payload);
      return handleBlandCallWebhook(
        new Request("https://sandra.test/h", { method: "POST", body, headers: { "x-webhook-signature": sign(body) } }),
        { client, secret: SECRET, dispatch },
      );
    };
    return { post, dispatch, complete };
  }

  it("confirmed non-connect on attempt 1: the retry is dispatched once, through dispatch", async () => {
    const t = setup([RETRY]);
    expect(await t.post(noAnswerCall("call-1"))).toEqual({ status: 200, body: { status: "applied", retry: "dispatched" } });
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("replay of attempt 1's webhook (any number of times): acknowledged, never a second dispatch", async () => {
    const t = setup([RETRY, { result: "replayed", status: "requested", outcome: null }, { result: "replayed", status: "dispatched", outcome: null }]);
    await t.post(noAnswerCall("call-1"));
    await t.post(noAnswerCall("call-1"));
    await t.post(noAnswerCall("call-1"));
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });

  it("attempt 2's own no_answer completes (no retry field, no dispatch)", async () => {
    const t = setup([{ result: "applied", status: "completed", outcome: "no_answer", released: 1 }]);
    expect((await t.post(noAnswerCall("call-2"))).body).toEqual({ status: "applied" });
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it("a dispatcher failure still acknowledges the webhook (the sweep dispatches the retry)", async () => {
    const t = setup([RETRY]);
    t.dispatch.mockRejectedValue(new Error("boom"));
    expect((await t.post(noAnswerCall("call-1"))).status).toBe(200);
  });
});

const NOW = Date.parse("2026-10-02T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe("reconciliation: call twice", () => {
  function setup(row: Record<string, unknown>, complete: unknown = RETRY) {
    const rpcs = {
      fn_norma_mark_dispatch_rejected: vi.fn().mockReturnValue("dispatch_rejected"),
      fn_norma_complete_call: vi.fn().mockReturnValue(complete),
    };
    const { client } = fakeClient({ norma_call_requests: [requestRow(row)] }, rpcs);
    const getCall = vi.fn().mockResolvedValue({ kind: "found", call: noAnswerCall("call-1") });
    const dispatch = vi.fn().mockResolvedValue({ status: "dispatched", callId: "c2" });
    const run = () => reconcileNormaCalls({ client, bland: { sendCall: vi.fn(), getCall }, dispatch, now: NOW });
    return { run, rpcs, dispatch };
  }

  it("a lookup that finds attempt 1 unanswered schedules and dispatches the retry once", async () => {
    const t = setup({ status: "dispatched", bland_call_id: "call-1", updated_at: ago(10 * MIN) });
    expect(await t.run()).toMatchObject({ completed: 1, dispatched: 1 });
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });

  it("a replayed completion dispatches nothing", async () => {
    const t = setup({ status: "dispatched", bland_call_id: "call-1", updated_at: ago(10 * MIN) }, { result: "replayed", status: "requested" });
    await t.run();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it("a stranded attempt-2 request is aged from its last update, not its creation", async () => {
    // Created long ago (the first call took a while), retry scheduled 2 minutes ago.
    const fresh = setup({ status: "requested", attempt: 2, created_at: ago(60 * MIN), updated_at: ago(2 * MIN) });
    expect(await fresh.run()).toMatchObject({ dispatched: 1 });
    expect(fresh.rpcs.fn_norma_mark_dispatch_rejected).not.toHaveBeenCalled();
    // The same age on attempt 1 is expired.
    const first = setup({ status: "requested", attempt: 1, created_at: ago(60 * MIN), updated_at: ago(2 * MIN) });
    expect(await first.run()).toMatchObject({ rejected: 1 });
    // A retry nobody picked up for longer than the expiry is closed, never dialled late.
    const stale = setup({ status: "requested", attempt: 2, created_at: ago(60 * MIN), updated_at: ago(10 * MIN) });
    expect(await stale.run()).toMatchObject({ rejected: 1 });
    expect(stale.dispatch).not.toHaveBeenCalled();
  });
});
