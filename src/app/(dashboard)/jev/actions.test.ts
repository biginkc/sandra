import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  rpcResult: { data: null as unknown, error: null as { message: string } | null },
  rpcResultsByName: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  needsDecisionQueueResult: { items: [] as unknown[], error: null as string | null },
  correctionHistoryCalls: [] as Array<{ propertyId: string; source: string; id: string }>,
  correctionHistoryResult: { entries: [] as unknown[], error: null as string | null },
  recordConsentEventCalls: [] as Array<{ contactId: string; eventType: string }>,
  recordConsentEventResult: { inserted: true, id: "consent-1" } as { inserted: true; id: string } | { inserted: false; id: string | null },
  pauseContactEnrollmentsCalls: [] as Array<{ contactId: string }>,
  recordLeadEventCalls: [] as Array<{ propertyId: string; eventType: string }>,
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
vi.mock("@/lib/messaging/consent", () => ({
  recordConsentEvent: async (_supabase: unknown, params: { contactId: string; eventType: string }) => {
    mocks.recordConsentEventCalls.push({ contactId: params.contactId, eventType: params.eventType });
    return mocks.recordConsentEventResult;
  },
}));
vi.mock("@/lib/sequences/enrollment", () => ({
  pauseContactEnrollments: async (_supabase: unknown, params: { contactId: string }) => {
    mocks.pauseContactEnrollmentsCalls.push({ contactId: params.contactId });
    return { paused: 0 };
  },
}));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { QUALIFIED: "qualified", DISPO_SET: "dispo_set", OPTED_OUT: "opted_out" },
  recordLeadEvent: async (args: { propertyId: string; eventType: string }) => {
    mocks.recordLeadEventCalls.push({ propertyId: args.propertyId, eventType: args.eventType });
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
  mocks.needsDecisionQueueResult = { items: [], error: null };
  mocks.correctionHistoryCalls = [];
  mocks.correctionHistoryResult = { entries: [], error: null };
  mocks.recordConsentEventCalls = [];
  mocks.recordConsentEventResult = { inserted: true, id: "consent-1" };
  mocks.pauseContactEnrollmentsCalls = [];
  mocks.recordLeadEventCalls = [];
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
    "calls fn_correct_ai_disposition_review directly for %s on an ai_disposition_review row (single atomic RPC, no separate sanctioned op)",
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
    },
  );

  it("calls fn_apply_and_record_ai_disposition_review_correction in a single RPC for new_lead — no separate begin/qualify/record round trips (root correction-race fix)", async () => {
    mocks.rpcResult = {
      data: { status: "corrected", correctedDisposition: "new_lead", propertyId: "prop-1", homeownerContactId: null },
      error: null,
    };
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "new_lead", "hot lead");
    expect(result).toEqual({ ok: true, data: { status: "corrected", resolvedOutcome: "new_lead" } });
    expect(mocks.rpcCalls).toEqual([
      {
        name: "fn_apply_and_record_ai_disposition_review_correction",
        args: { p_review_id: "review-1", p_corrected_disposition: "new_lead", p_reason: "hot lead" },
      },
    ]);
  });

  it.each(["opted_out", "dnc"] as const)(
    "calls fn_apply_and_record_ai_disposition_review_correction in a single RPC for %s, then runs best-effort consent/enrollment follow-ups using the RPC's OWN returned property/contact ids",
    async (target) => {
      mocks.rpcResult = {
        data: { status: "corrected", correctedDisposition: target, propertyId: "prop-2", homeownerContactId: "contact-2" },
        error: null,
      };
      const result = await correctJevQueueItem("ai_disposition_review", "review-1", target, "actually stop");
      expect(result).toEqual({ ok: true, data: { status: "corrected", resolvedOutcome: target } });
      expect(mocks.rpcCalls).toEqual([
        {
          name: "fn_apply_and_record_ai_disposition_review_correction",
          args: { p_review_id: "review-1", p_corrected_disposition: target, p_reason: "actually stop" },
        },
      ]);
      expect(mocks.recordConsentEventCalls).toEqual([{ contactId: "contact-2", eventType: "opt_out" }]);
      expect(mocks.pauseContactEnrollmentsCalls).toEqual([{ contactId: "contact-2" }]);
    },
  );

  it.each(["opted_out", "dnc"] as const)(
    "calls fn_apply_and_record_jev_lead_decision_correction in a single RPC for %s on a jev_lead_decision row",
    async (target) => {
      mocks.rpcResult = {
        data: { status: "corrected", resolvedOutcome: target, propertyId: "prop-3", homeownerContactId: "contact-3" },
        error: null,
      };
      const result = await correctJevQueueItem("jev_lead_decision", "decision-1", target, null);
      expect(result).toEqual({ ok: true, data: { status: "corrected", resolvedOutcome: target } });
      expect(mocks.rpcCalls).toEqual([
        {
          name: "fn_apply_and_record_jev_lead_decision_correction",
          args: { p_decision_id: "decision-1", p_corrected_outcome: target, p_reason: "" },
        },
      ]);
      expect(mocks.recordConsentEventCalls).toEqual([{ contactId: "contact-3", eventType: "opt_out" }]);
    },
  );

  it("does not run consent/enrollment follow-ups when the property has no homeowner contact", async () => {
    mocks.rpcResult = {
      data: { status: "corrected", correctedDisposition: "opted_out", propertyId: "prop-4", homeownerContactId: null },
      error: null,
    };
    await correctJevQueueItem("ai_disposition_review", "review-1", "opted_out", null);
    expect(mocks.recordConsentEventCalls).toHaveLength(0);
    expect(mocks.pauseContactEnrollmentsCalls).toHaveLength(0);
  });

  it("fails the whole correction — and runs no follow-ups — when the atomic RPC rejects a stale/mismatched review (STALE_STATE from the RPC's own transaction, not a separate pre-check)", async () => {
    mocks.rpcResult = { data: null, error: { message: "STALE_STATE" } };
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "new_lead", null);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "JEV_CORRECTION_FAILED",
        message: "This lead changed since Jev made this decision. Reload and try again.",
      },
    });
    expect(mocks.rpcCalls).toEqual([
      {
        name: "fn_apply_and_record_ai_disposition_review_correction",
        args: { p_review_id: "review-1", p_corrected_disposition: "new_lead", p_reason: "" },
      },
    ]);
    expect(mocks.recordConsentEventCalls).toHaveLength(0);
  });

  it("surfaces a friendly DNC_LOCKED message when the atomic RPC rejects a locked property", async () => {
    mocks.rpcResult = { data: null, error: { message: "DNC_LOCKED: property is permanently read-only" } };
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "new_lead", null);
    expect(result).toEqual({
      ok: false,
      error: { code: "JEV_CORRECTION_FAILED", message: "This property is permanently locked and cannot be promoted." },
    });
  });

  it("reports the exact-repeat status distinctly ('already_corrected') for a resend of an already-completed correction, and runs it through as a success", async () => {
    mocks.rpcResult = {
      data: { status: "already_corrected", correctedDisposition: "opted_out", propertyId: "prop-5", homeownerContactId: "contact-5" },
      error: null,
    };
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "opted_out", null);
    expect(result).toEqual({ ok: true, data: { status: "already_corrected", resolvedOutcome: "opted_out" } });
    // Exact-repeat is handled entirely inside the atomic RPC (no new write,
    // no new audit row there) — the TS layer only runs suppression
    // follow-ups for a genuinely new "corrected" status, not a replay.
    expect(mocks.recordConsentEventCalls).toHaveLength(0);
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

  it("fails when the atomic RPC succeeds but returns no resolved outcome (defensive — should never happen from a well-formed RPC)", async () => {
    mocks.rpcResult = { data: { status: "corrected" }, error: null };
    const result = await correctJevQueueItem("ai_disposition_review", "review-1", "new_lead", null);
    expect(result.ok).toBe(false);
    expect(mocks.recordConsentEventCalls).toHaveLength(0);
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
