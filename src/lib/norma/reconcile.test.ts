import { describe, expect, it, vi } from "vitest";

import type { BlandClient, BlandLookupResult } from "./bland";
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
    expect(t.rpcs.fn_norma_mark_dispatch_rejected).toHaveBeenCalledWith({ p_request_id: REQUEST_ID, p_reason: "stranded_requested_expired" });
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
});
