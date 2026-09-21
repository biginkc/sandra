import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  rpcResult: { data: null as unknown, error: null as { message: string } | null },
  rpcResultsByName: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  setOutreachDispoResult: { ok: true } as { ok: true } | { ok: false; error: string },
  setOutreachDispoCalls: [] as Array<{ propertyId: string; dispo: string }>,
  qualifyPropertyResult: { status: "qualified" } as
    | { status: "qualified" }
    | { status: "already_qualified" }
    | { status: "not_found" }
    | { status: "failed"; message: string },
  qualifyPropertyCalls: [] as Array<{ propertyId: string; qualifiedBy: string | null }>,
  needsDecisionQueueResult: { items: [] as unknown[], error: null as string | null },
  correctionHistoryCalls: [] as Array<{ propertyId: string; source: string; id: string }>,
  correctionHistoryResult: { entries: [] as unknown[], error: null as string | null },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user } }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      mocks.rpcCalls.push({ name, args });
      return mocks.rpcResultsByName[name] ?? mocks.rpcResult;
    },
  }),
}));
vi.mock("@/app/(dashboard)/messages/dispo-actions", () => ({
  setOutreachDispo: async (propertyId: string, dispo: string) => {
    mocks.setOutreachDispoCalls.push({ propertyId, dispo });
    return mocks.setOutreachDispoResult;
  },
}));
vi.mock("@/lib/leads/qualify", () => ({
  qualifyProperty: async (_supabase: unknown, propertyId: string, qualifiedBy: string | null) => {
    mocks.qualifyPropertyCalls.push({ propertyId, qualifiedBy });
    return mocks.qualifyPropertyResult;
  },
}));
vi.mock("./queries", () => ({
  getNeedsDecisionQueue: async () => mocks.needsDecisionQueueResult,
  getCorrectionHistory: async (propertyId: string, source: string, id: string) => {
    mocks.correctionHistoryCalls.push({ propertyId, source, id });
    return mocks.correctionHistoryResult;
  },
}));

import {
  confirmJevQueueItem,
  correctJevQueueItem,
  fetchCorrectionHistory,
  markJevQueueItemReviewed,
  promoteClassifierEventToDecision,
} from "./actions";

beforeEach(() => {
  mocks.user = { id: "user-1" };
  mocks.rpcCalls = [];
  mocks.rpcResultsByName = {};
  mocks.setOutreachDispoCalls = [];
  mocks.qualifyPropertyCalls = [];
  mocks.setOutreachDispoResult = { ok: true };
  mocks.qualifyPropertyResult = { status: "qualified" };
  mocks.needsDecisionQueueResult = { items: [], error: null };
  mocks.correctionHistoryCalls = [];
  mocks.correctionHistoryResult = { entries: [], error: null };
});

describe("confirmJevQueueItem", () => {
  it("rejects an unauthenticated caller before calling any RPC", async () => {
    mocks.user = null;
    const result = await confirmJevQueueItem("ai_disposition_review", "review-1");
    expect(result).toEqual({ ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } });
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("calls fn_confirm_ai_disposition_review for an ai_disposition_review source", async () => {
    mocks.rpcResult = { data: { status: "confirmed" }, error: null };
    const result = await confirmJevQueueItem("ai_disposition_review", "review-1");
    expect(result).toEqual({ ok: true, data: { status: "confirmed" } });
    expect(mocks.rpcCalls).toEqual([
      { name: "fn_confirm_ai_disposition_review", args: { p_review_id: "review-1" } },
    ]);
  });

  it("calls fn_confirm_jev_lead_decision for a jev_lead_decision source", async () => {
    mocks.rpcResult = { data: { status: "confirmed" }, error: null };
    const result = await confirmJevQueueItem("jev_lead_decision", "decision-1");
    expect(result).toEqual({ ok: true, data: { status: "confirmed" } });
    expect(mocks.rpcCalls).toEqual([
      { name: "fn_confirm_jev_lead_decision", args: { p_decision_id: "decision-1" } },
    ]);
  });

  it("rejects a classifier_event source without calling any RPC", async () => {
    const result = await confirmJevQueueItem("classifier_event", "event-1");
    expect(result.ok).toBe(false);
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("surfaces a friendly DNC_LOCKED message for a jev_lead_decision confirm failure", async () => {
    mocks.rpcResult = { data: null, error: { message: "DNC_LOCKED" } };
    const result = await confirmJevQueueItem("jev_lead_decision", "decision-1");
    expect(result).toEqual({
      ok: false,
      error: {
        code: "JEV_CONFIRM_FAILED",
        message: "This property is permanently locked and cannot be promoted.",
      },
    });
  });
});

describe("markJevQueueItemReviewed", () => {
  it("rejects an unauthenticated caller before calling any RPC", async () => {
    mocks.user = null;
    const result = await markJevQueueItemReviewed("ai_disposition_review", "review-1");
    expect(result.ok).toBe(false);
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("calls fn_mark_ai_disposition_review_reviewed for an already-applied auto_accepted row", async () => {
    mocks.rpcResult = { data: { status: "reviewed" }, error: null };
    const result = await markJevQueueItemReviewed("ai_disposition_review", "review-1");
    expect(result).toEqual({ ok: true, data: { status: "reviewed" } });
    expect(mocks.rpcCalls).toEqual([
      { name: "fn_mark_ai_disposition_review_reviewed", args: { p_review_id: "review-1" } },
    ]);
  });

  it("calls fn_mark_jev_lead_decision_reviewed for a jev_lead_decision source", async () => {
    mocks.rpcResult = { data: { status: "reviewed" }, error: null };
    const result = await markJevQueueItemReviewed("jev_lead_decision", "decision-1");
    expect(result).toEqual({ ok: true, data: { status: "reviewed" } });
    expect(mocks.rpcCalls).toEqual([
      { name: "fn_mark_jev_lead_decision_reviewed", args: { p_decision_id: "decision-1" } },
    ]);
  });

  it("rejects a classifier_event source without calling any RPC", async () => {
    const result = await markJevQueueItemReviewed("classifier_event", "event-1");
    expect(result.ok).toBe(false);
    expect(mocks.rpcCalls).toHaveLength(0);
  });
});

describe("correctJevQueueItem", () => {
  it("rejects an unauthenticated caller before calling any RPC or sanctioned operation", async () => {
    mocks.user = null;
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "nurture", null);
    expect(result.ok).toBe(false);
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("rejects an outcome outside the full taxonomy before calling any RPC", async () => {
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "bogus", null);
    expect(result.ok).toBe(false);
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("rejects a classifier_event source — no decision was made, nothing to correct", async () => {
    const result = await correctJevQueueItem("classifier_event", "event-1", "nurture", null);
    expect(result.ok).toBe(false);
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it.each(["wrong_number", "not_interested", "nurture"] as const)(
    "calls fn_correct_ai_disposition_review directly for %s on an ai_disposition_review row (no begin/record RPCs, no sanctioned op)",
    async (target) => {
      mocks.rpcResult = { data: { status: "corrected", correctedDisposition: target }, error: null };
      const result = await correctJevQueueItem("ai_disposition_review", "review-1", target, "reason");
      expect(result).toEqual({ ok: true, data: { status: "corrected", resolvedOutcome: target } });
      expect(mocks.rpcCalls).toEqual([
        {
          name: "fn_correct_ai_disposition_review",
          args: { p_review_id: "review-1", p_corrected_disposition: target, p_reason: "reason" },
        },
      ]);
      expect(mocks.setOutreachDispoCalls).toHaveLength(0);
      expect(mocks.qualifyPropertyCalls).toHaveLength(0);
    },
  );

  it("begins the correction (deriving the authoritative property id), then calls qualifyProperty with THAT id, then records — for new_lead on an ai_disposition_review row", async () => {
    mocks.rpcResultsByName.fn_begin_ai_disposition_review_correction = {
      data: { propertyId: "authoritative-prop-1" },
      error: null,
    };
    mocks.rpcResultsByName.fn_record_ai_disposition_review_correction = {
      data: { status: "corrected" },
      error: null,
    };
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "new_lead", "hot lead");
    expect(result).toEqual({ ok: true, data: { status: "corrected", resolvedOutcome: "new_lead" } });
    expect(mocks.rpcCalls[0]).toEqual({
      name: "fn_begin_ai_disposition_review_correction",
      args: { p_review_id: "review-1", p_corrected_disposition: "new_lead" },
    });
    // The property id used for the sanctioned op is the one the begin RPC
    // returned — never a caller-supplied one (root final-review P1 #2).
    expect(mocks.qualifyPropertyCalls).toEqual([{ propertyId: "authoritative-prop-1", qualifiedBy: "user-1" }]);
    expect(mocks.rpcCalls[1]).toEqual({
      name: "fn_record_ai_disposition_review_correction",
      args: { p_review_id: "review-1", p_corrected_disposition: "new_lead", p_reason: "hot lead" },
    });
  });

  it.each(["opted_out", "dnc"] as const)(
    "begins the correction, calls setOutreachDispo with the authoritative property id, then records — for %s on an ai_disposition_review row",
    async (target) => {
      mocks.rpcResultsByName.fn_begin_ai_disposition_review_correction = {
        data: { propertyId: "authoritative-prop-2" },
        error: null,
      };
      mocks.rpcResultsByName.fn_record_ai_disposition_review_correction = {
        data: { status: "corrected" },
        error: null,
      };
      const result = await correctJevQueueItem("ai_disposition_review", "review-1", target, "actually stop");
      expect(result).toEqual({ ok: true, data: { status: "corrected", resolvedOutcome: target } });
      expect(mocks.setOutreachDispoCalls).toEqual([{ propertyId: "authoritative-prop-2", dispo: target }]);
      expect(mocks.rpcCalls[1]).toEqual({
        name: "fn_record_ai_disposition_review_correction",
        args: { p_review_id: "review-1", p_corrected_disposition: target, p_reason: "actually stop" },
      });
    },
  );

  it.each(["opted_out", "dnc"] as const)(
    "begins the correction, calls setOutreachDispo with the authoritative property id, then records — for %s on a jev_lead_decision row",
    async (target) => {
      mocks.rpcResultsByName.fn_begin_jev_lead_decision_correction = {
        data: { propertyId: "authoritative-prop-3" },
        error: null,
      };
      mocks.rpcResultsByName.fn_record_jev_lead_decision_correction = {
        data: { status: "corrected" },
        error: null,
      };
      const result = await correctJevQueueItem("jev_lead_decision", "decision-1", target, null);
      expect(result).toEqual({ ok: true, data: { status: "corrected", resolvedOutcome: target } });
      expect(mocks.setOutreachDispoCalls).toEqual([{ propertyId: "authoritative-prop-3", dispo: target }]);
      expect(mocks.rpcCalls[1]).toEqual({
        name: "fn_record_jev_lead_decision_correction",
        args: { p_decision_id: "decision-1", p_corrected_outcome: target, p_reason: "" },
      });
    },
  );

  it("fails the whole correction — without calling qualifyProperty or any record RPC — when fn_begin_ai_disposition_review_correction rejects a stale/mismatched review", async () => {
    mocks.rpcResultsByName.fn_begin_ai_disposition_review_correction = {
      data: null,
      error: { message: "STALE_STATE" },
    };
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "new_lead", null);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "JEV_CORRECTION_FAILED",
        message: "This lead changed since Jev made this decision. Reload and try again.",
      },
    });
    expect(mocks.qualifyPropertyCalls).toHaveLength(0);
    expect(mocks.rpcCalls).toEqual([
      { name: "fn_begin_ai_disposition_review_correction", args: { p_review_id: "review-1", p_corrected_disposition: "new_lead" } },
    ]);
  });

  it("does not call any record RPC when qualifyProperty fails after a successful begin (never silently drops the failure)", async () => {
    mocks.rpcResultsByName.fn_begin_ai_disposition_review_correction = {
      data: { propertyId: "authoritative-prop-4" },
      error: null,
    };
    mocks.qualifyPropertyResult = { status: "failed", message: "DNC_LOCKED: property is permanently read-only" };
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "new_lead", null);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "JEV_CORRECTION_FAILED",
        message: "This property is permanently locked and cannot be promoted.",
      },
    });
    expect(mocks.rpcCalls).toEqual([
      { name: "fn_begin_ai_disposition_review_correction", args: { p_review_id: "review-1", p_corrected_disposition: "new_lead" } },
    ]);
  });

  it("does not call any record RPC when setOutreachDispo fails after a successful begin (never silently drops the failure)", async () => {
    mocks.rpcResultsByName.fn_begin_ai_disposition_review_correction = {
      data: { propertyId: "authoritative-prop-5" },
      error: null,
    };
    mocks.setOutreachDispoResult = { ok: false, error: "Disposition changed in another session. Refresh and try again." };
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "dnc", null);
    expect(result).toEqual({
      ok: false,
      error: { code: "JEV_CORRECTION_FAILED", message: "Disposition changed in another session. Refresh and try again." },
    });
    expect(mocks.rpcCalls).toEqual([
      { name: "fn_begin_ai_disposition_review_correction", args: { p_review_id: "review-1", p_corrected_disposition: "dnc" } },
    ]);
  });

  it("reports a real failure — not success — when the sanctioned operation succeeded but the audit-record RPC failed (root final-review P1 #2: truthful success only after audit is durable)", async () => {
    mocks.rpcResultsByName.fn_begin_ai_disposition_review_correction = {
      data: { propertyId: "authoritative-prop-6" },
      error: null,
    };
    mocks.rpcResultsByName.fn_record_ai_disposition_review_correction = {
      data: null,
      error: { message: "unexpected db error" },
    };
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "dnc", null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("JEV_CORRECTION_RECORD_FAILED");
    }
    expect(mocks.setOutreachDispoCalls).toEqual([{ propertyId: "authoritative-prop-6", dispo: "dnc" }]);
  });

  it("surfaces a friendly STALE_STATE message for a direct-SQL correction failure", async () => {
    mocks.rpcResult = { data: null, error: { message: "STALE_STATE" } };
    const result = await correctJevQueueItem("jev_lead_decision", "decision-1", "nurture", null);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "JEV_CORRECTION_FAILED",
        message: "This lead changed since Jev made this decision. Reload and try again.",
      },
    });
  });

  it("fails when fn_begin_* succeeds but returns no propertyId (defensive — should never happen from a well-formed RPC)", async () => {
    mocks.rpcResultsByName.fn_begin_ai_disposition_review_correction = {
      data: { reviewId: "review-1" },
      error: null,
    };
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "new_lead", null);
    expect(result.ok).toBe(false);
    expect(mocks.qualifyPropertyCalls).toHaveLength(0);
  });
});

describe("promoteClassifierEventToDecision — root final-review P1 #3", () => {
  it("rejects an unauthenticated caller before calling any RPC", async () => {
    mocks.user = null;
    const result = await promoteClassifierEventToDecision("run-1");
    expect(result.ok).toBe(false);
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("calls fn_promote_classifier_event_to_decision with the classification run id", async () => {
    mocks.rpcResult = { data: { status: "promoted", decisionId: "decision-1" }, error: null };
    const result = await promoteClassifierEventToDecision("run-1");
    expect(result).toEqual({ ok: true, data: { status: "promoted", decisionId: "decision-1" } });
    expect(mocks.rpcCalls).toEqual([
      { name: "fn_promote_classifier_event_to_decision", args: { p_classification_run_id: "run-1" } },
    ]);
  });

  it("surfaces the already_promoted status idempotently (never an error) for a replayed promotion", async () => {
    mocks.rpcResult = { data: { status: "already_promoted", decisionId: "decision-1" }, error: null };
    const result = await promoteClassifierEventToDecision("run-1");
    expect(result).toEqual({ ok: true, data: { status: "already_promoted", decisionId: "decision-1" } });
  });

  it("fails when the RPC errors, e.g. a run that isn't actually a classifier_event", async () => {
    mocks.rpcResult = { data: null, error: { message: "NOT_A_CLASSIFIER_EVENT" } };
    const result = await promoteClassifierEventToDecision("run-1");
    expect(result.ok).toBe(false);
  });

  it("fails when the RPC returns no decisionId (defensive — should never happen from a well-formed RPC)", async () => {
    mocks.rpcResult = { data: { status: "promoted" }, error: null };
    const result = await promoteClassifierEventToDecision("run-1");
    expect(result.ok).toBe(false);
  });
});

describe("fetchCorrectionHistory — root final-review P2", () => {
  it("returns the full correction history queried for this property/source/id", async () => {
    mocks.correctionHistoryResult = {
      entries: [{ id: "e1", correctedOutcome: "nurture", createdAt: "2026-09-20T00:00:00.000Z" }],
      error: null,
    };
    const result = await fetchCorrectionHistory("prop-1", "ai_disposition_review", "review-1");
    expect(result).toEqual({
      ok: true,
      data: { entries: [{ id: "e1", correctedOutcome: "nurture", createdAt: "2026-09-20T00:00:00.000Z" }] },
    });
    expect(mocks.correctionHistoryCalls).toEqual([
      { propertyId: "prop-1", source: "ai_disposition_review", id: "review-1" },
    ]);
  });

  it("fails when the underlying query errors", async () => {
    mocks.correctionHistoryResult = { entries: [], error: "connection reset" };
    const result = await fetchCorrectionHistory("prop-1", "jev_lead_decision", "decision-1");
    expect(result).toEqual({ ok: false, error: { code: "JEV_HISTORY_FAILED", message: "connection reset" } });
  });
});
