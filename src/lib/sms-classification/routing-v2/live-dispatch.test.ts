import { describe, expect, it } from "vitest";

import { vi } from "vitest";
import { askJev } from "../providers/jev-gateway";
import { JevAttemptsError, v2ProviderDeps } from "./classify";
import { liveHoldReason, liveStepFor, recordRoutingV2Audit, recordV2ModelSpend, storedFinalDecision, storedV2Decision, V2_LIVE_JEV_POLICY, type StoredLiveEvidence } from "./live-dispatch";

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
  it("the live v2 Jev dep reports every HTTP attempt it made (answer or failure)", async () => {
    const lookupValue = vi.fn();
    const ok = vi.fn()
      .mockResolvedValueOnce(new Response("x", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: {} }), { status: 200 }));
    const deps = v2ProviderDeps({ jev: { fetch: ok, apiKey: "k", ...V2_LIVE_JEV_POLICY }, haiku: {} as never, lookupValue });
    await expect(deps.jev({ state: {}, questions: {} })).resolves.toMatchObject({ attempts: ["server_error", "ok"] });
    const denied = vi.fn().mockResolvedValue(new Response("no", { status: 401 }));
    const failing = v2ProviderDeps({ jev: { fetch: denied, apiKey: "k", ...V2_LIVE_JEV_POLICY }, haiku: {} as never, lookupValue });
    const err = await failing.jev({ state: {}, questions: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(JevAttemptsError);
    expect(err.attempts).toEqual(["auth"]);
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
  it("one Jev row per HTTP attempt: failed attempts without tokens, the answering attempt with them", async () => {
    const { calls, db } = rpcDb();
    await recordV2ModelSpend(db, ctx, { kind: "decided", jevUsage: { input_tokens: 1200, output_tokens: 300 }, jevAttempts: ["timeout", "server_error", "ok"], haiku: null } as never, () => {});
    expect(calls).toEqual([
      expect.objectContaining({ p_provider: "jev", p_outcome: "attempt_failed:timeout", p_input_tokens: null }),
      expect.objectContaining({ p_provider: "jev", p_outcome: "attempt_failed:server_error", p_input_tokens: null }),
      expect.objectContaining({ p_provider: "jev", p_outcome: "decided", p_input_tokens: 1200, p_output_tokens: 300 }),
    ]);
  });
  it("Jev never called (no attempt made): no Jev row; every attempt of a failed call is counted", async () => {
    const none = rpcDb();
    await recordV2ModelSpend(none.db, ctx, { kind: "failed", reason: "jev_failed", jevAttempts: [] }, () => {});
    expect(none.calls).toEqual([]);
    const failed = rpcDb();
    await recordV2ModelSpend(failed.db, ctx, { kind: "failed", reason: "jev_failed", jevAttempts: ["timeout", "timeout", "timeout"] }, () => {});
    expect(failed.calls.map((c) => c.p_outcome)).toEqual(["attempt_failed:timeout", "attempt_failed:timeout", "attempt_failed:timeout"]);
  });
});

describe("AUDIT: one v2 audit row per inbound", () => {
  const P = "11111111-1111-4111-8111-111111111111";
  function fake(flags: unknown, insertError: { code?: string; message: string } | null = null) {
    const inserts: Array<Record<string, unknown>> = [];
    const db = {
      from: (t: string) => ({
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { routing_v2_flags: flags }, error: null }) }), maybeSingle: async () => ({ data: t === "properties" ? { org_id: "o", decision_context_revision: 4 } : { routing_v2_flags: flags }, error: null }) }) }),
        insert: async (r: Record<string, unknown>) => { inserts.push({ t, ...r }); return { error: insertError }; },
      }),
    };
    return { db: db as never, inserts };
  }
  it("flags off: nothing written", async () => {
    const { db, inserts } = fake({});
    expect(await recordRoutingV2Audit(db, { orgId: "o", propertyId: P, inboundMessageId: "i", note: "stop_keyword:x" })).toBe("skipped");
    expect(inserts).toEqual([]);
  });
  it("v2-live property the engine never decided: one not_routed row with the reason", async () => {
    const { db, inserts } = fake({ questions_live: true, canary_property_ids: [P] });
    expect(await recordRoutingV2Audit(db, { orgId: "o", propertyId: P, inboundMessageId: "i", note: "dispatch:skipped" })).toBe("recorded");
    expect(inserts).toEqual([expect.objectContaining({ t: "routing_v2_live_decisions", status: "not_routed", failure_reason: "dispatch:skipped", inbound_message_id: "i", expected_revision: 4 })]);
  });
  it("already decided by the engine (unique inbound): exists, untouched", async () => {
    const { db } = fake({ questions_live: true, canary_property_ids: [P] }, { code: "23505", message: "duplicate" });
    expect(await recordRoutingV2Audit(db, { orgId: "o", propertyId: P, inboundMessageId: "i", note: "dispatch:auto_closed" })).toBe("exists");
  });
});
