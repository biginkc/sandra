import { describe, expect, it } from "vitest";

import { preSendTransition, type PreSendResult } from "./pre-send-transition";

// PROPOSED module/shape (RED): pure `preSendTransition(result)` for plan rule 4 (+ H1).
// Input is a discriminated union of every request result the dispatcher / reconcile can produce;
// output is the entry transition, whether an attempt is counted, and the request's resulting status.
// Rows come straight from the plan's rule-4 table; nothing here adds a business rule.

describe("preSendTransition — requeue rows (nothing counted, request closed dispatch_rejected)", () => {
  const requeue = { entry: "queued", countsAttempt: false, requestStatus: "dispatch_rejected" };

  it.each<[string, PreSendResult]>([
    ["queue_refused:<reason> (window closed)", { kind: "queue_refused", reason: "window_closed" }],
    ["queue_refused:<reason> (lease expired)", { kind: "queue_refused", reason: "lease_expired" }],
    ["capacity_concurrency", { kind: "capacity_concurrency" }],
    ["capacity_daily", { kind: "capacity_daily" }],
    ["number_busy", { kind: "number_busy" }],
    ["gate:dispatch_disabled", { kind: "gate", reason: "dispatch_disabled" }],
    ["gate:number_not_allowed", { kind: "gate", reason: "number_not_allowed" }],
    ["bland_not_configured", { kind: "bland_not_configured" }],
    ["pre_send_error (retry next tick)", { kind: "pre_send_error" }],
    ["stranded_requested_expired (reconcile; queue rows are never dispatched by reconcile, S1)", { kind: "stranded_requested_expired" }],
  ])("%s -> queued, no attempt counted", (_label, result) => {
    expect(preSendTransition(result)).toMatchObject(requeue);
  });

  it("requeue rows never pause, end, or carry an end reason", () => {
    const out = preSendTransition({ kind: "capacity_daily" });
    expect(out.pauseReason).toBeUndefined();
    expect(out.endReason).toBeUndefined();
  });
});

describe("preSendTransition — ineligible", () => {
  it.each(["dnc_locked", "not_interested", "no_callable_number"])("ineligible:%s -> done, blocked:<reason>, nothing counted", (reason) => {
    expect(preSendTransition({ kind: "ineligible", reason })).toMatchObject({
      entry: "done",
      endReason: `blocked:${reason}`,
      countsAttempt: false,
      requestStatus: "dispatch_rejected",
    });
  });
});

describe("preSendTransition — Bland HTTP results", () => {
  it.each([400, 401, 403, 404, 422, 429])("Bland %i (4xx except 408) -> paused:provider_refused with the reason", (httpStatus) => {
    expect(preSendTransition({ kind: "bland_http", httpStatus })).toMatchObject({
      entry: "paused",
      pauseReason: "provider_refused",
      countsAttempt: false,
      requestStatus: "dispatch_rejected",
    });
  });

  it.each([408, 500, 502, 503, 504])("Bland %i (408 / 5xx) -> send attempted: entry stays calling, attempt counted, request dispatch_unknown", (httpStatus) => {
    expect(preSendTransition({ kind: "bland_http", httpStatus })).toMatchObject({
      entry: "calling",
      countsAttempt: true,
      requestStatus: "dispatch_unknown",
    });
  });

  it("Bland timeout -> same as unknown: entry stays calling, attempt counted, dispatch_unknown", () => {
    expect(preSendTransition({ kind: "bland_timeout" })).toMatchObject({
      entry: "calling",
      countsAttempt: true,
      requestStatus: "dispatch_unknown",
    });
  });

  it("an unknown send does not park or end the entry (resolved only by webhook, reconcile or review)", () => {
    const out = preSendTransition({ kind: "bland_timeout" });
    expect(out.pauseReason).toBeUndefined();
    expect(out.endReason).toBeUndefined();
  });

});

describe("preSendTransition — totality", () => {
  it("returns a transition for every kind (no throw, no undefined)", () => {
    const all: PreSendResult[] = [
      { kind: "queue_refused", reason: "x" },
      { kind: "capacity_concurrency" },
      { kind: "capacity_daily" },
      { kind: "number_busy" },
      { kind: "gate", reason: "dispatch_disabled" },
      { kind: "bland_not_configured" },
      { kind: "ineligible", reason: "x" },
      { kind: "pre_send_error" },
      { kind: "bland_http", httpStatus: 400 },
      { kind: "bland_http", httpStatus: 503 },
      { kind: "bland_timeout" },
      { kind: "stranded_requested_expired" },
    ];
    for (const result of all) {
      const out = preSendTransition(result);
      expect(["queued", "done", "paused", "calling"]).toContain(out.entry);
      expect(typeof out.countsAttempt).toBe("boolean");
    }
  });

  it("is pure: the same input gives an equal output", () => {
    expect(preSendTransition({ kind: "number_busy" })).toEqual(preSendTransition({ kind: "number_busy" }));
  });
});
