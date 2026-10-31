import { describe, expect, it } from "vitest";

import { vi } from "vitest";
import { askJev } from "../providers/jev-gateway";
import { liveHoldReason, liveStepFor, recordV2ModelSpend, storedFinalDecision, storedV2Decision, V2_LIVE_JEV_POLICY, type StoredLiveEvidence } from "./live-dispatch";

const base: StoredLiveEvidence = {
  status: "decided", org_id: "o", property_id: "p", road: "who_reply_drip", jev_road: "who_reply_drip",
  provenance: { by: "jev", row: "15", step: "asked_who", signal: "asked_who", probability: 0.9 } as StoredLiveEvidence["provenance"],
  haiku_eligibility: null, haiku: null, opportunity_alert: false,
  action: { road: "who_reply_drip", steps: [{ kind: "reply", key: "identity" }] }, expected_revision: 1, failure_reason: null,
};
const withAction = (road: string, steps: unknown[]) => ({ ...base, road, action: { road, steps } } as StoredLiveEvidence);

describe("live v2 step selection from stored evidence", () => {
  it.each([
    [{ ...base, status: "failed", action: null, failure_reason: "jev_incomplete" } as StoredLiveEvidence, { kind: "failed", reason: "jev_incomplete" }],
    [withAction("stop", [{ kind: "hold", reason: "asked_stop" }]), { kind: "stop" }],
    [withAction("wrong_number_close", [{ kind: "wrong_number_close" }]), { kind: "wrong_number" }],
    [withAction("bad_number", [{ kind: "hold", reason: "bad_number" }]), { kind: "bad_number" }],
    [withAction("possible_stop", [{ kind: "hold", reason: "asked_stop" }, { kind: "alert", reason: "possible_stop" }]), { kind: "hold", reason: "asked_stop" }],
    [withAction("haiku_error", [{ kind: "hold", reason: "needs_person" }, { kind: "alert", reason: "haiku_error" }]), { kind: "hold", reason: "needs_person" }],
    [base, { kind: "transition" }],
  ])("%#", (e, step) => {
    expect(liveStepFor(e)).toEqual(step);
  });
  it("holds only with registered reasons", () => {
    expect(liveHoldReason("asked_stop")).toBe("nine_asked_stop");
    expect(liveHoldReason("needs_person")).toBe("nine_needs_person");
    expect(liveHoldReason("bad_number")).toBe("nine_needs_person");
  });
  it("rebuilds Jev's original decision (not the post-Haiku road) and the recorded final", () => {
    const e = { ...base, road: "haiku_unsure", jev_road: "stop", haiku_eligibility: "decider_band", haiku: { final_road: "stop", final_by: "jev_haiku_unsure", hold: true, alert: "x", failure_reason: null } } as StoredLiveEvidence;
    expect(storedV2Decision(e)).toMatchObject({ road: "stop", haiku: "decider_band" });
    expect(storedFinalDecision(e)).toEqual({ road: "stop", by: "jev_haiku_unsure", hold: true, alert: "x", failureReason: null });
    expect(storedV2Decision({ ...base, status: "failed" })).toBeNull();
  });
});

describe("A-4: live v2 Jev retries match the legacy classifier", () => {
  it("2 bounded retries on 5xx / timeout (askJev's default), then success", async () => {
    expect(V2_LIVE_JEV_POLICY).toEqual({ maxRetries: 2, timeoutMs: 8000 });
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("x", { status: 503 }))
      .mockResolvedValueOnce(new Response("x", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: {} }), { status: 200 }));
    await expect(askJev({ state: {}, questions: {} }, { fetch, apiKey: "k", ...V2_LIVE_JEV_POLICY })).resolves.toMatchObject({ answers: {} });
    expect(fetch).toHaveBeenCalledTimes(3);
  }, 20_000);
});

describe("A-6: Jev / Haiku spend ledger rows", () => {
  const ctx = { orgId: "o", propertyId: "p", inboundMessageId: "i" };
  const rpcDb = () => { const calls: Array<Record<string, unknown>> = []; return { calls, db: { rpc: async (_f: string, a: Record<string, unknown>) => { calls.push(a); return { error: null }; } } as never }; };
  it("one Jev row (+ one Haiku row when Haiku was asked) with tokens and cost", async () => {
    const { calls, db } = rpcDb();
    await recordV2ModelSpend(db, ctx, { kind: "decided", jevUsage: { input_tokens: 1200, output_tokens: 300 }, haiku: { ok: true, option: "lot", confidence: 0.3, inputTokens: 900, outputTokens: 20, costUsd: 0.0001 } } as never, () => {});
    expect(calls).toEqual([
      expect.objectContaining({ p_provider: "jev", p_outcome: "decided", p_input_tokens: 1200, p_output_tokens: 300, p_inbound_message_id: "i" }),
      expect.objectContaining({ p_provider: "haiku", p_outcome: "answered", p_input_tokens: 900, p_cost: 0.0001 }),
    ]);
  });
  it("a failed Jev call is still counted; a ledger failure never throws", async () => {
    const { calls, db } = rpcDb();
    await recordV2ModelSpend(db, ctx, { kind: "failed", reason: "jev_failed" }, () => {});
    expect(calls).toEqual([expect.objectContaining({ p_provider: "jev", p_outcome: "jev_failed", p_input_tokens: null })]);
    const report = vi.fn();
    await recordV2ModelSpend({ rpc: async () => ({ error: { message: "down" } }) } as never, ctx, { kind: "failed", reason: "jev_failed" }, report);
    expect(report).toHaveBeenCalledOnce();
  });
});
