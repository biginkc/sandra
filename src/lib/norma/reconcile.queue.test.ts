import { describe, expect, it, vi } from "vitest";

import type { BlandClient, BlandLookupResult } from "./bland";
import { reconcileNormaCalls, RECONCILE_THRESHOLDS as T } from "./reconcile";
import { fakeClient, KEY, PHONE, REQUEST_ID, requestRow } from "./test-helpers";

// RED (S1 / H4): reconcile NEVER dispatches a request that carries queue_entry_id (only the queue tick dials those); aged `requested`
// queue rows are closed as stranded_requested_expired (settled per rule 4 in SQL). The existing #793 branches stay as they are:
// button rows are still dispatched in the grace..expiry window, attempt-2 rows still use idleAge, dispatchScheduledRetry still runs.
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const NOW = Date.parse("2026-10-02T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const QUEUE = { queue_entry_id: "entry-1" };

function setup(row: Record<string, unknown>, lookup?: BlandLookupResult, complete: Record<string, unknown> = { result: "applied", status: "completed", outcome: "no_answer" }) {
  const rpcs = {
    fn_norma_mark_dispatch_rejected: vi.fn().mockReturnValue("dispatch_rejected"),
    // contract s.4: queue rows are closed through the queue store port, which settles the entry per rule 4 (returns applied | noop | no_entry)
    fn_norma_queue_apply_presend: vi.fn().mockReturnValue("applied"),
    fn_norma_mark_dispatch_unknown: vi.fn().mockReturnValue("dispatch_unknown"),
    fn_norma_mark_needs_review: vi.fn().mockReturnValue("needs_review"),
    fn_norma_complete_call: vi.fn().mockReturnValue(complete),
  };
  const { client } = fakeClient({ norma_call_requests: [requestRow(row)] }, rpcs);
  const bland: BlandClient = { sendCall: vi.fn(), getCall: vi.fn().mockResolvedValue(lookup ?? { kind: "unknown", reason: "http_500" }) };
  const dispatch = vi.fn().mockResolvedValue({ status: "dispatched", callId: "c" });
  const run = () => reconcileNormaCalls({ client, bland, dispatch, now: NOW });
  return { run, rpcs, dispatch };
}

const finished = (): BlandLookupResult => ({
  kind: "found",
  call: { call_id: "call-1", to: PHONE, completed: true, status: "no-answer", answered_by: "no-answer", metadata: { request_id: REQUEST_ID, idempotency_key: KEY }, variables: {} },
});

describe("reconcile — a busy-refused button request is closed and never dispatched later", () => {
  it("a request closed as dispatch_rejected (capacity_*/number_busy) is not picked up by the sweep", async () => {
    for (const reason of ["capacity_concurrency", "capacity_daily", "number_busy"]) {
      const t = setup({ status: "dispatch_rejected", created_at: ago(2 * MIN), last_error: reason });
      await t.run();
      expect(t.dispatch).not.toHaveBeenCalled();
    }
  });
});

describe("reconcile — queue requests are never dispatched by the sweep (S1)", () => {
  it("inside the grace window: left alone", async () => {
    const t = setup({ ...QUEUE, status: "requested", created_at: ago(10_000) });
    expect(await t.run()).toMatchObject({ waiting: 1 });
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(t.rpcs.fn_norma_mark_dispatch_rejected).not.toHaveBeenCalled();
  });

  it("stranded but fresh (the window where a button row WOULD be dispatched): not dispatched, not closed, still waiting", async () => {
    const t = setup({ ...QUEUE, status: "requested", created_at: ago(2 * MIN) });
    expect(await t.run()).toMatchObject({ dispatched: 0, waiting: 1 });
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(t.rpcs.fn_norma_mark_dispatch_rejected).not.toHaveBeenCalled();
  });

  it("aged past the expiry: closed as stranded_requested_expired (only if still `requested`), never dispatched", async () => {
    const t = setup({ ...QUEUE, status: "requested", created_at: ago(T.requestedExpiry + MIN) });
    expect(await t.run()).toMatchObject({ rejected: 1 });
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(t.rpcs.fn_norma_queue_apply_presend).toHaveBeenCalledWith({ p_request_id: REQUEST_ID, p_result: "stranded_requested_expired" });
    expect(t.rpcs.fn_norma_mark_dispatch_rejected).not.toHaveBeenCalled();
  });

  it("expiry close loses the race to a claim (apply_presend answers noop): counted as waiting, not rejected", async () => {
    const t = setup({ ...QUEUE, status: "requested", created_at: ago(T.requestedExpiry + MIN) });
    t.rpcs.fn_norma_queue_apply_presend.mockReturnValue("noop");
    expect(await t.run()).toMatchObject({ rejected: 0, waiting: 1 });
  });

  it("a queue row's completed Bland call is still settled through complete_call, and never triggers a dispatch", async () => {
    const t = setup({ ...QUEUE, status: "dispatched", bland_call_id: "call-1", updated_at: ago(10 * MIN) }, finished());
    expect(await t.run()).toMatchObject({ completed: 1 });
    expect(t.rpcs.fn_norma_complete_call).toHaveBeenCalledTimes(1);
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it("stuck queue rows keep the existing fences: dispatching with no id goes to dispatch_unknown, never redialled", async () => {
    const t = setup({ ...QUEUE, status: "dispatching", updated_at: ago(T.dispatchingStale + MIN) });
    expect(await t.run()).toMatchObject({ markedUnknown: 1 });
    expect(t.rpcs.fn_norma_mark_dispatch_unknown).toHaveBeenCalledWith({ p_request_id: REQUEST_ID, p_reason: "stranded_dispatching", p_expected_attempt: 1 });
    expect(t.dispatch).not.toHaveBeenCalled();
  });
});

describe("reconcile — existing #793 button branches are unchanged (H4)", () => {
  it("a button row (queue_entry_id null) in the grace..expiry window is still dispatched", async () => {
    const t = setup({ queue_entry_id: null, status: "requested", created_at: ago(2 * MIN) });
    expect(await t.run()).toMatchObject({ dispatched: 1 });
    expect(t.dispatch).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("a button row past the expiry is still closed, not dispatched", async () => {
    const t = setup({ queue_entry_id: null, status: "requested", created_at: ago(T.requestedExpiry + MIN) });
    expect(await t.run()).toMatchObject({ rejected: 1 });
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(t.rpcs.fn_norma_mark_dispatch_rejected).toHaveBeenCalledWith(expect.objectContaining({ p_request_id: REQUEST_ID, p_reason: "stranded_requested_expired" }));
    expect(t.rpcs.fn_norma_queue_apply_presend).not.toHaveBeenCalled();
  });

  it("attempt 2 still ages by idleAge (last update), not creation: old row, recent update -> waits", async () => {
    const t = setup({ queue_entry_id: null, attempt: 2, status: "requested", created_at: ago(3 * 60 * MIN), updated_at: ago(10_000) });
    expect(await t.run()).toMatchObject({ waiting: 1 });
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it("attempt 2 with an idle age inside grace..expiry is still dispatched even though it was created hours ago", async () => {
    const t = setup({ queue_entry_id: null, attempt: 2, status: "requested", created_at: ago(3 * 60 * MIN), updated_at: ago(2 * MIN) });
    expect(await t.run()).toMatchObject({ dispatched: 1 });
    expect(t.dispatch).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("dispatchScheduledRetry still runs for a button row whose completion reports retry:true", async () => {
    const t = setup(
      { queue_entry_id: null, status: "dispatched", bland_call_id: "call-1", updated_at: ago(10 * MIN) },
      finished(),
      { result: "applied", status: "requested", outcome: "no_answer", retry: true },
    );
    expect(await t.run()).toMatchObject({ completed: 1, dispatched: 1 });
    expect(t.dispatch).toHaveBeenCalledWith(REQUEST_ID);
  });
});
