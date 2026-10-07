import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordStep } = vi.hoisted(() => ({
  recordStep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pipeline-runs", () => ({ recordStep }));

import { classifyForDispatch } from "./dispatch-bridge";

// Minimal client: every table answers the few reads the bridge makes.
function stubSupabase(thresholds: Array<{ outcome: string; min_confidence: number; automation_enabled?: boolean }> = []) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.eq = self;
  chain.order = self;
  chain.limit = self;
  chain.neq = self;
  chain.lte = self;
  chain.maybeSingle = async () => ({
    data: { created_at: "2026-09-21T00:00:00.000Z", decision_context_revision: 3 },
    error: null,
  });
  chain.insert = () => ({
    select: () => ({ maybeSingle: async () => ({ data: { id: "run-1" }, error: null }) }),
    then: (resolve: (r: { error: null }) => void) => resolve({ error: null }),
  });
  chain.then = (resolve: (r: { data: unknown[]; error: null }) => void) =>
    resolve({ data: [], error: null });
  const thresholdsChain = {
    select: () => thresholdsChain,
    eq: async () => ({
      data: thresholds.map((t) => ({ automation_enabled: true, ...t, version: 1 })),
      error: null,
    }),
  };
  return {
    from: (table: string) => (table === "jev_outcome_thresholds" ? thresholdsChain : chain),
  } as never;
}

function stubFetch(body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

const input = {
  orgId: "org-1",
  propertyId: "prop-1",
  contactId: "c-1",
  conversationId: "conv-1",
  inboundMessageId: "msg-1",
  inboundBody: "seller words that must never be recorded",
};
const ctx = { runId: "run-9", orgId: "org-1", seq: 0 };

describe("classifyForDispatch evidence steps", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records jev + threshold + shadow would_apply in shadow mode, with no seller text", async () => {
    const fn = stubFetch({ answers: { outcome: { choice: "not_interested", confidence: 0.9 } } });
    const result = await classifyForDispatch(
      stubSupabase([{ outcome: "not_interested", min_confidence: 0.8 }]),
      input,
      { classifierProvider: "jev", classifierMode: "shadow" },
      { fetch: fn, typesafeApiKey: "k", runContext: ctx },
    );
    expect(result).toMatchObject({ kind: "use_legacy" });
    const steps = recordStep.mock.calls.map((c) => c[2]);
    expect(steps.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "jev:classify",
      "threshold:resolve_threshold",
      "shadow:would_apply",
    ]);
    expect(steps[0].detail).toMatchObject({
      classificationRunId: "run-1",
      outcome: "not_interested",
    });
    expect(steps[1].detail).toMatchObject({ decision: "auto_apply", threshold: 0.8, version: 1 });
    expect(steps[2]).toMatchObject({ result: "would_apply" });
    expect(steps[2].detail).toMatchObject({ outcome: "not_interested", wouldRoute: "close_not_interested" });
    expect(JSON.stringify(steps)).not.toContain("seller words");
    expect(recordStep.mock.calls.every((c) => c[1] === ctx)).toBe(true);
  });

  it("records no shadow step in automatic mode and reports needs_decision below threshold", async () => {
    const fn = stubFetch({ answers: { outcome: { choice: "not_interested", confidence: 0.5 } } });
    await classifyForDispatch(
      stubSupabase([{ outcome: "not_interested", min_confidence: 0.8 }]),
      input,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch: fn, typesafeApiKey: "k", runContext: ctx },
    );
    const steps = recordStep.mock.calls.map((c) => c[2]);
    expect(steps.map((s) => s.kind)).toEqual(["jev", "threshold"]);
    expect(steps[1].detail).toMatchObject({ decision: "needs_decision", threshold: 0.8 });
  });

  it("holds a 1.0-confidence new_lead for a human when automation is disabled (records the held threshold step)", async () => {
    const fn = stubFetch({ answers: { outcome: { choice: "new_lead", confidence: 1 }, escalation_reason: { choice: "call_request" } } });
    const result = await classifyForDispatch(
      stubSupabase([{ outcome: "new_lead", min_confidence: 0.9, automation_enabled: false }]),
      input,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch: fn, typesafeApiKey: "k", runContext: ctx },
    );
    expect(result.kind).toBe("jev_route");
    const threshold = recordStep.mock.calls.map((c) => c[2]).find((s) => s.kind === "threshold");
    expect(threshold).toMatchObject({ result: "held" });
    expect(threshold.detail).toMatchObject({ decision: "human_gated", reason: "automation_disabled" });
  });

  it("records an error jev step when the provider fails", async () => {
    const failing = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "x" })) as unknown as typeof fetch;
    await classifyForDispatch(
      stubSupabase(),
      input,
      { classifierProvider: "jev", classifierMode: "shadow" },
      { fetch: failing, typesafeApiKey: "k", runContext: ctx },
    );
    expect(recordStep.mock.calls[0][2]).toMatchObject({ kind: "jev", name: "classify", result: "error" });
  });

  it("passes undefined ctx straight through (recorder no-ops) when none supplied", async () => {
    const fn = stubFetch({ answers: { outcome: { choice: "not_interested", confidence: 0.9 } } });
    await classifyForDispatch(
      stubSupabase(),
      input,
      { classifierProvider: "jev", classifierMode: "shadow" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    expect(recordStep.mock.calls.every((c) => c[1] === undefined)).toBe(true);
  });
});
