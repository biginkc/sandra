import { describe, expect, it, vi } from "vitest";

import type { BlandClient, BlandLookupResult } from "./bland";
import { dispatchNormaCall } from "./dispatch";
import { reconcileNormaCalls, RECONCILE_THRESHOLDS as T } from "./reconcile";
import { fakeClient, KEY, PHONE, REQUEST_ID, requestRow } from "./test-helpers";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const NOW = Date.parse("2026-10-02T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

function setup(row: Record<string, unknown>, lookup?: BlandLookupResult, includeNeedsReview = false) {
  const rpcs = {
    fn_norma_mark_dispatch_rejected: vi.fn().mockReturnValue("dispatch_rejected"),
    fn_norma_mark_dispatch_unknown: vi.fn().mockReturnValue("dispatch_unknown"),
    fn_norma_mark_needs_review: vi.fn().mockReturnValue("needs_review"),
    fn_norma_complete_call: vi.fn().mockReturnValue({ result: "applied", status: "completed", outcome: "no_answer" }),
  };
  const { client } = fakeClient({ norma_call_requests: [requestRow(row)] }, rpcs);
  const getCall = vi.fn().mockResolvedValue(lookup ?? { kind: "unknown", reason: "http_500" });
  const bland: BlandClient = { sendCall: vi.fn(), getCall };
  const dispatch = vi.fn().mockResolvedValue({ status: "dispatched", callId: "c" });
  const run = () => reconcileNormaCalls({ client, bland, dispatch, now: NOW, includeNeedsReview });
  return { run, rpcs, getCall, dispatch, bland };
}
const finished = (extra: Record<string, unknown> = {}): BlandLookupResult => ({
  kind: "found",
  call: { call_id: "call-1", to: PHONE, completed: true, status: "no-answer", answered_by: "no-answer", metadata: { request_id: REQUEST_ID, idempotency_key: KEY }, variables: {}, ...extra },
});

describe("reconciliation", () => {
  it("requested: within the grace window is left alone", async () => {
    const t = setup({ status: "requested", created_at: ago(10_000) });
    expect(await t.run()).toMatchObject({ waiting: 1 });
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it("requested: stranded but fresh is dispatched through dispatchNormaCall", async () => {
    const t = setup({ status: "requested", created_at: ago(2 * MIN) });
    expect(await t.run()).toMatchObject({ dispatched: 1 });
    expect(t.dispatch).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("requested: older than the expiry is rejected (pauses released in SQL), never dialled", async () => {
    const t = setup({ status: "requested", created_at: ago(T.requestedExpiry + MIN) });
    expect(await t.run()).toMatchObject({ rejected: 1 });
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(t.rpcs.fn_norma_mark_dispatch_rejected).toHaveBeenCalledWith({ p_request_id: REQUEST_ID, p_reason: "stranded_requested_expired", p_expected_status: "requested" });
  });

  it("expiry close loses the race to a claim: counted as waiting, not rejected", async () => {
    const t = setup({ status: "requested", created_at: ago(T.requestedExpiry + MIN) });
    t.rpcs.fn_norma_mark_dispatch_rejected.mockReturnValue("dispatching");
    expect(await t.run()).toMatchObject({ rejected: 0, waiting: 1 });
  });

  it("dispatching with no id: stale -> dispatch_unknown (fence), fresh -> wait; never redials", async () => {
    const stale = setup({ status: "dispatching", updated_at: ago(T.dispatchingStale + MIN) });
    expect(await stale.run()).toMatchObject({ markedUnknown: 1 });
    expect(stale.dispatch).not.toHaveBeenCalled();
    const fresh = setup({ status: "dispatching", updated_at: ago(10_000) });
    expect(await fresh.run()).toMatchObject({ waiting: 1 });
    expect(fresh.rpcs.fn_norma_mark_dispatch_unknown).not.toHaveBeenCalled();
  });

  it("dispatched + Bland says finished: completes through the shared RPC", async () => {
    const t = setup({ status: "dispatched", bland_call_id: "call-1", updated_at: ago(5 * MIN) }, finished());
    expect(await t.run()).toMatchObject({ completed: 1 });
    expect(t.rpcs.fn_norma_complete_call).toHaveBeenCalledWith(expect.objectContaining({ p_request_id: REQUEST_ID, p_call_id: "call-1", p_outcome: "no_answer" }));
  });

  it("a completion the database does not apply is reported and escalates after the window instead of throwing", async () => {
    const t = setup({ status: "dispatched", bland_call_id: "call-1", updated_at: ago(T.escalateAfter + MIN) }, finished());
    t.rpcs.fn_norma_complete_call.mockReturnValue({ result: "mismatch" });
    expect(await t.run()).toMatchObject({ completed: 0, errors: 1, escalated: 1 });
    expect(t.rpcs.fn_norma_mark_needs_review).toHaveBeenCalled();
    const fresh = setup({ status: "dispatched", bland_call_id: "call-1", updated_at: ago(5 * MIN) }, finished());
    fresh.rpcs.fn_norma_complete_call.mockReturnValue({ result: "mismatch" });
    expect(await fresh.run()).toMatchObject({ completed: 0, errors: 1, waiting: 1, escalated: 0 });
  });

  it("dispatched shortly after dispatch: not looked up yet", async () => {
    const t = setup({ status: "dispatched", bland_call_id: "call-1", updated_at: ago(30_000) }, finished());
    expect(await t.run()).toMatchObject({ waiting: 1 });
    expect(t.getCall).not.toHaveBeenCalled();
  });

  it("dispatched, call still running or lookup failing: waits, then escalates; never redials or resumes", async () => {
    const running = setup({ status: "dispatched", bland_call_id: "call-1", updated_at: ago(10 * MIN) }, { kind: "found", call: { call_id: "call-1", to: PHONE, completed: false } });
    expect(await running.run()).toMatchObject({ waiting: 1 });
    const stuck = setup({ status: "dispatched", bland_call_id: "call-1", updated_at: ago(T.escalateAfter + MIN) }, { kind: "not_found" });
    expect(await stuck.run()).toMatchObject({ escalated: 1 });
    expect(stuck.rpcs.fn_norma_mark_needs_review).toHaveBeenCalled();
    expect(stuck.dispatch).not.toHaveBeenCalled();
    expect(stuck.rpcs.fn_norma_mark_dispatch_rejected).not.toHaveBeenCalled();
  });

  it("a Bland call that does not match the request is reported, never applied", async () => {
    for (const bad of [finished({ to: "+18165550000" }), finished({ metadata: { idempotency_key: "other" } }), finished({ call_id: "different" })]) {
      const t = setup({ status: "dispatched", bland_call_id: "call-1", updated_at: ago(5 * MIN) }, bad);
      expect(await t.run()).toMatchObject({ errors: 1, completed: 0 });
      expect(t.rpcs.fn_norma_complete_call).not.toHaveBeenCalled();
    }
  });

  it("a call that keeps not matching is escalated after the window, not left open forever", async () => {
    for (const bad of [finished({ to: "+18165550000" }), finished({ metadata: { idempotency_key: "other" } }), finished({ call_id: "different" })]) {
      const t = setup({ status: "dispatched", bland_call_id: "call-1", updated_at: ago(T.escalateAfter + MIN) }, bad);
      expect(await t.run()).toMatchObject({ errors: 1, completed: 0, escalated: 1 });
      expect(t.rpcs.fn_norma_complete_call).not.toHaveBeenCalled();
      expect(t.rpcs.fn_norma_mark_needs_review).toHaveBeenCalledTimes(1);
    }
  });

  it("dispatch_unknown with no id: waits, then escalates to needs_review (Bland has no metadata lookup)", async () => {
    const early = setup({ status: "dispatch_unknown", updated_at: ago(MIN) });
    expect(await early.run()).toMatchObject({ waiting: 1 });
    const late = setup({ status: "dispatch_unknown", updated_at: ago(T.unknownNoIdEscalateAfter + MIN) });
    expect(await late.run()).toMatchObject({ escalated: 1 });
    expect(late.getCall).not.toHaveBeenCalled();
    expect(late.dispatch).not.toHaveBeenCalled();
  });

  it("needs_review is only rechecked on the slow cadence, and a late real outcome completes it", async () => {
    const skipped = setup({ status: "needs_review", bland_call_id: "call-1", updated_at: ago(2 * T.escalateAfter) }, finished(), false);
    expect(await skipped.run()).toMatchObject({ scanned: 0 });
    const rechecked = setup({ status: "needs_review", bland_call_id: "call-1", updated_at: ago(2 * T.escalateAfter) }, finished(), true);
    expect(await rechecked.run()).toMatchObject({ completed: 1 });
  });

  it("needs_review whose result still does not map is left alone (no churn, no escalation loop)", async () => {
    const t = setup({ status: "needs_review", bland_call_id: "call-1", outcome: "unknown", updated_at: ago(2 * T.escalateAfter) }, finished({ status: "failed", answered_by: null }), true);
    expect(await t.run()).toMatchObject({ waiting: 1, completed: 0, escalated: 0 });
    expect(t.rpcs.fn_norma_complete_call).not.toHaveBeenCalled();
  });

  it("every examined row is pushed out by next_check_at; rows not yet due are not scanned (no starvation)", async () => {
    const t = setup({ status: "dispatched", bland_call_id: "call-1", updated_at: ago(10 * MIN) }, { kind: "unknown", reason: "http_500" });
    const { client, updates } = fakeClient(
      {
        norma_call_requests: [
          requestRow({ id: "stuck", status: "dispatched", bland_call_id: "c1", updated_at: ago(10 * MIN), next_check_at: new Date(NOW + 60_000).toISOString() }),
          requestRow({ id: "fresh", status: "dispatched", bland_call_id: "c2", updated_at: ago(10 * MIN), next_check_at: new Date(NOW - 1000).toISOString() }),
        ],
      },
      {},
    );
    const summary = await reconcileNormaCalls({ client, bland: t.bland, dispatch: t.dispatch, now: NOW });
    expect(summary.scanned).toBe(1);
    expect(t.getCall).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([{ table: "norma_call_requests", values: { next_check_at: new Date(NOW + T.recheckAfter).toISOString() }, id: "fresh" }]);
  });

  it("closed gate + REAL dispatchNormaCall: a stranded request is closed and Bland send-call is never called", async () => {
    const sendCall = vi.fn();
    const rpcs = {
      fn_norma_claim_dispatch: vi.fn(),
      fn_norma_eligibility: vi.fn(),
      fn_norma_bind_call_id: vi.fn(),
      fn_norma_mark_dispatch_rejected: vi.fn().mockReturnValue("dispatch_rejected"),
    };
    const { client } = fakeClient({ norma_call_requests: [requestRow({ status: "requested", created_at: ago(2 * MIN) })] }, rpcs);
    const bland: BlandClient = { sendCall, getCall: vi.fn() };
    const summary = await reconcileNormaCalls({
      client, bland, now: NOW,
      dispatch: (id) =>
        dispatchNormaCall(id, {
          client, bland,
          blandConfig: { apiKey: "k", baseUrl: "https://bland.test", pathwayId: "p", pathwayVersion: 3, voice: "v", fromNumber: "+12135550100", webhookUrl: "https://x.test/h", timeoutMs: 1000, waitForGreeting: true, backgroundTrack: "office" },
          gate: { dispatchEnabled: false, sellerRelease: true, allowedNumbers: [PHONE] },
        }),
    });
    expect(summary.rejected).toBe(1);
    expect(sendCall).not.toHaveBeenCalled();
    expect(rpcs.fn_norma_claim_dispatch).not.toHaveBeenCalled();
    expect(rpcs.fn_norma_mark_dispatch_rejected).toHaveBeenCalledWith({ p_request_id: REQUEST_ID, p_reason: "gate:dispatch_disabled", p_expected_status: "requested" });
  });
});

describe("callback time conversion in reconciliation", () => {
  it("converts the seller's words before completing a callback", async () => {
    const rpcs = { fn_norma_complete_call: vi.fn().mockReturnValue({ result: "applied", status: "completed", outcome: "callback_requested" }) };
    const { client } = fakeClient(
      { norma_call_requests: [requestRow({ status: "dispatched", bland_call_id: "call-1", updated_at: ago(10 * MIN) })], properties: [{ id: "p1", state: "OH" }] },
      rpcs,
    );
    const getCall = vi.fn().mockResolvedValue({
      kind: "found",
      call: {
        call_id: "call-1", to: PHONE, completed: true, status: "completed", answered_by: "human",
        started_at: ago(12 * MIN), corrected_duration: 120, metadata: { request_id: REQUEST_ID, idempotency_key: KEY },
        variables: { call_outcome: "callback_requested", follow_up_preference: "tomorrow afternoon" },
      },
    });
    const bland: BlandClient = { sendCall: vi.fn(), getCall };
    const summary = await reconcileNormaCalls({ client, bland, dispatch: vi.fn(), now: NOW });
    expect(summary.completed).toBe(1);
    // 2026-10-02 12:00Z is Friday 08:00 New York; tomorrow 14:00 EDT = 18:00Z.
    expect(rpcs.fn_norma_complete_call.mock.calls[0]![0].p_payload).toMatchObject({
      callback_requested_for: "2026-10-03T18:00:00.000Z", callback_timezone: "America/New_York",
    });
  });
});

