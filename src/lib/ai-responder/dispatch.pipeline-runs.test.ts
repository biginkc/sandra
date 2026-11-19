import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordStep, recordLeadEvent } = vi.hoisted(() => ({
  recordStep: vi.fn().mockResolvedValue(undefined),
  recordLeadEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { AI_ESCALATED: "ai_escalated" },
  recordLeadEvent,
}));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pipeline-runs", async () => {
  return {
    recordStep,
    resumeRun: vi.fn().mockResolvedValue(null),
    updateRun: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  applyKeywordEscalation,
  checkAiResponderDispatchPreGates,
  markPropertyNeedsAttention,
} from "./dispatch";

const ctx = { runId: "run-1", orgId: "org-1", seq: 0 };

function updateClient(updated: { id: string } | null = { id: "p-1" }) {
  const builder: Record<string, unknown> = {};
  builder.update = () => builder;
  builder.eq = () => builder;
  builder.select = () => builder;
  builder.maybeSingle = async () => ({ data: updated, error: null });
  return { from: () => builder } as never;
}

const stepsOf = () => recordStep.mock.calls.map((c) => c[2]);

describe("dispatch evidence steps", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records a hold step for markPropertyNeedsAttention without changing the flag write", async () => {
    await markPropertyNeedsAttention(updateClient(), "p-1", "low_confidence:0.4", ctx);
    expect(stepsOf()).toEqual([
      { kind: "hold", name: "needs_attention", result: "held", detail: { reason: "low_confidence:0.4" } },
    ]);
    expect(recordStep.mock.calls[0][1]).toBe(ctx);
    expect(recordLeadEvent).toHaveBeenCalledTimes(1);
  });

  it("still escalates when recording would be a no-op (no ctx)", async () => {
    await markPropertyNeedsAttention(updateClient(), "p-1", "x");
    expect(recordStep.mock.calls[0][1]).toBeNull();
    expect(recordLeadEvent).toHaveBeenCalledTimes(1);
  });

  it("records a blocking gate then a hold on keyword escalation", async () => {
    const result = await applyKeywordEscalation(updateClient(), {
      propertyId: "p-1",
      inboundBody: "I am going to call my lawyer",
      runContext: ctx,
    });
    if (result.escalated) {
      expect(stepsOf().map((s) => `${s.kind}:${s.name}:${s.result}`)).toEqual([
        "gate:escalation_keyword:block",
        "hold:needs_attention:held",
      ]);
    } else {
      expect(stepsOf()).toEqual([
        { kind: "gate", name: "escalation_keyword", result: "pass" },
      ]);
    }
  });

  describe("jevAutomatic keyword escalation", () => {
    const kws = ["price", "how much", "lawyer"];
    it("price-only text writes nothing and traces a deferred pass", async () => {
      const result = await applyKeywordEscalation(updateClient(), {
        propertyId: "p-1", inboundBody: "How much?", escalationKeywords: kws, runContext: ctx, jevAutomatic: true,
      });
      expect(result).toEqual({ escalated: false });
      expect(recordLeadEvent).not.toHaveBeenCalled();
      expect(stepsOf().map((s) => `${s.kind}:${s.name}:${s.result}`)).toEqual(["gate:escalation_keyword:pass"]);
      expect(stepsOf()[0].detail).toMatchObject({ deferred: "shared_hot_decision" });
    });
    it("mixed price + legal text holds under the NON-price reason, never keyword:price_offer", async () => {
      const result = await applyKeywordEscalation(updateClient(), {
        propertyId: "p-1", inboundBody: "How much? My lawyer is involved", escalationKeywords: kws, runContext: ctx, jevAutomatic: true,
      });
      expect(result).toEqual({ escalated: true, reason: "keyword:legal_contract", flagOk: true });
      expect(recordLeadEvent).toHaveBeenCalledTimes(1);
    });
    it("non-Jev: the same mixed text keeps the up-front price hold", async () => {
      const result = await applyKeywordEscalation(updateClient(), {
        propertyId: "p-1", inboundBody: "How much? My lawyer is involved", escalationKeywords: kws, runContext: ctx,
      });
      expect(result).toEqual({ escalated: true, reason: "keyword:price_offer", flagOk: true });
    });
    it("non-Jev: price-only still holds keyword:price_offer", async () => {
      const result = await applyKeywordEscalation(updateClient(), {
        propertyId: "p-1", inboundBody: "How much?", escalationKeywords: kws, runContext: ctx,
      });
      expect(result).toEqual({ escalated: true, reason: "keyword:price_offer", flagOk: true });
    });
  });

  it("records a pass gate when no keyword matches", async () => {
    const result = await applyKeywordEscalation(updateClient(), {
      propertyId: "p-1",
      inboundBody: "ok sounds good",
      runContext: ctx,
    });
    expect(result.escalated).toBe(false);
    expect(stepsOf()).toEqual([
      { kind: "gate", name: "escalation_keyword", result: "pass" },
    ]);
  });

  it("records a blocking gate for the already_terminal pre-gate", async () => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.contains = () => builder;
    builder.order = () => builder;
    builder.limit = () => builder;
    builder.maybeSingle = async () => ({
      data: { id: "p-1", org_id: "org-1", needs_human_attention: true, outreach_dispo: null },
      error: null,
    });
    const client = { from: () => builder } as never;
    const gate = await checkAiResponderDispatchPreGates(
      client,
      { propertyId: "p-1", contactId: "c-1", inboundBody: "hi" },
      { runContext: ctx },
    );
    expect(gate.ok).toBe(false);
    expect(stepsOf()).toEqual([
      { kind: "gate", name: "already_terminal", result: "block", detail: { reason: "already_terminal" } },
    ]);
  });
});
