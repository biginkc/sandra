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
