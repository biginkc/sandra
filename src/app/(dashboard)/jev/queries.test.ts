import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aiDispositionReviews: [] as unknown[],
  jevLeadDecisions: [] as unknown[],
  classificationRuns: [] as unknown[],
  promotedClassificationRunIds: [] as string[],
  leadEvents: [] as unknown[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table === "lead_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: mocks.leadEvents, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "ai_disposition_reviews") {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: mocks.aiDispositionReviews, error: null }),
            }),
          }),
        };
      }
      if (table === "jev_lead_decisions") {
        return {
          select: (columns: string) => {
            if (columns === "classification_run_id") {
              return {
                in: (_col: string, ids: string[]) =>
                  Promise.resolve({
                    data: mocks.promotedClassificationRunIds
                      .filter((id) => ids.includes(id))
                      .map((id) => ({ classification_run_id: id })),
                    error: null,
                  }),
              };
            }
            return {
              eq: () => ({
                order: () => Promise.resolve({ data: mocks.jevLeadDecisions, error: null }),
              }),
            };
          },
        };
      }
      if (table === "sms_classification_runs") {
        return {
          select: () => ({
            eq: () => ({
              or: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: mocks.classificationRuns, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  }),
}));

import { getCorrectionHistory, getNeedsDecisionQueue, summarize, type JevQueueItem } from "./queries";

beforeEach(() => {
  mocks.aiDispositionReviews = [];
  mocks.jevLeadDecisions = [];
  mocks.classificationRuns = [];
  mocks.promotedClassificationRunIds = [];
  mocks.leadEvents = [];
});

function item(overrides: Partial<JevQueueItem> = {}): JevQueueItem {
  return {
    id: "id-1",
    source: "ai_disposition_review",
    propertyId: "prop-1",
    propertyAddress: "123 Main St",
    conversationId: "conv-1",
    proposedOutcome: "not_interested",
    status: "confirmed",
    resolvedOutcome: "not_interested",
    correctedOutcome: null,
    nativeConfidence: 0.97,
    thresholdAtDecision: 0.95,
    thresholdVersion: 1,
    evidenceBody: "not interested",
    createdAt: "2026-09-20T00:00:00.000Z",
    resolvedAt: "2026-09-20T00:05:00.000Z",
    resolvedBy: "user-1",
    correctionReason: null,
    humanReviewedAt: null,
    actionable: true,
    applicationState: "applied",
    model: "jev-1.13.0",
    schemaVersion: "2",
    policyVersion: "2026-09-20-new-lead-review",
    correctionTargets: ["new_lead", "wrong_number", "not_interested", "nurture", "opted_out", "dnc"],
    ...overrides,
  };
}

describe("summarize", () => {
  it("counts a pending item as pending, not agreed or corrected", () => {
    const summary = summarize([item({ status: "pending", resolvedOutcome: null, resolvedBy: null })]);
    expect(summary.coverage).toEqual({
      total: 1,
      pending: 1,
      autoAppliedUnreviewed: 0,
      reviewedByHuman: 0,
      superseded: 0,
      failedOrHeld: 0,
    });
    expect(summary.reviewedAgreement).toEqual({});
  });

  it("counts a superseded item in its own bucket, never as auto-applied-unreviewed", () => {
    const summary = summarize([
      item({ status: "superseded", applicationState: "superseded", resolvedBy: null, resolvedOutcome: null }),
    ]);
    expect(summary.coverage).toEqual({
      total: 1,
      pending: 0,
      autoAppliedUnreviewed: 0,
      reviewedByHuman: 0,
      superseded: 1,
      failedOrHeld: 0,
    });
    expect(summary.reviewedAgreement).toEqual({});
  });

  it("counts a classifier_event (failure/unclear, no backing review row) in its own bucket", () => {
    const summary = summarize([
      item({
        source: "classifier_event",
        status: "failed",
        applicationState: "failed",
        actionable: false,
        resolvedBy: null,
        resolvedOutcome: null,
        correctionTargets: [],
      }),
    ]);
    expect(summary.coverage).toEqual({
      total: 1,
      pending: 0,
      autoAppliedUnreviewed: 0,
      reviewedByHuman: 0,
      superseded: 0,
      failedOrHeld: 1,
    });
  });

  it("counts a system auto-applied row (resolvedBy null, never marked reviewed) as unreviewed, never as agreement", () => {
    const summary = summarize([item({ status: "auto_accepted", resolvedBy: null, humanReviewedAt: null })]);
    expect(summary.coverage.autoAppliedUnreviewed).toBe(1);
    expect(summary.coverage.reviewedByHuman).toBe(0);
    expect(summary.reviewedAgreement).toEqual({});
  });

  it("counts an auto-applied row a human marked reviewed (without correcting it) as reviewed/agreed", () => {
    const summary = summarize([
      item({ status: "auto_accepted", resolvedBy: null, humanReviewedAt: "2026-09-21T00:00:00.000Z" }),
    ]);
    expect(summary.coverage.autoAppliedUnreviewed).toBe(0);
    expect(summary.coverage.reviewedByHuman).toBe(1);
    expect(summary.reviewedAgreement).toEqual({ not_interested: { agreed: 1, corrected: 0 } });
  });

  it("counts a human-confirmed row (unchanged outcome) as agreed", () => {
    const summary = summarize([item({ status: "confirmed", resolvedBy: "user-1", correctedOutcome: null })]);
    expect(summary.coverage.reviewedByHuman).toBe(1);
    expect(summary.reviewedAgreement).toEqual({ not_interested: { agreed: 1, corrected: 0 } });
  });

  it("counts a human correction to a different outcome as corrected, keyed by the ORIGINAL proposal", () => {
    const summary = summarize([
      item({
        status: "corrected",
        resolvedBy: "user-1",
        proposedOutcome: "nurture",
        correctedOutcome: "not_interested",
      }),
    ]);
    expect(summary.reviewedAgreement).toEqual({ nurture: { agreed: 0, corrected: 1 } });
  });

  it("does not count a correction back to the same outcome as a correction", () => {
    const summary = summarize([
      item({ status: "corrected", resolvedBy: "user-1", proposedOutcome: "nurture", correctedOutcome: "nurture" }),
    ]);
    expect(summary.reviewedAgreement).toEqual({ nurture: { agreed: 1, corrected: 0 } });
  });

  it("aggregates coverage and per-outcome agreement across a mixed batch", () => {
    const summary = summarize([
      item({ status: "pending", resolvedOutcome: null, resolvedBy: null }),
      item({ status: "superseded", applicationState: "superseded", resolvedBy: null, resolvedOutcome: null }),
      item({
        source: "classifier_event",
        status: "failed",
        applicationState: "failed",
        actionable: false,
        resolvedBy: null,
        resolvedOutcome: null,
      }),
      item({ status: "auto_accepted", resolvedBy: null, humanReviewedAt: null }),
      item({ status: "confirmed", resolvedBy: "user-1", proposedOutcome: "not_interested", correctedOutcome: null }),
      item({
        status: "corrected",
        resolvedBy: "user-2",
        proposedOutcome: "not_interested",
        correctedOutcome: "nurture",
      }),
    ]);
    expect(summary.coverage).toEqual({
      total: 6,
      pending: 1,
      autoAppliedUnreviewed: 1,
      reviewedByHuman: 2,
      superseded: 1,
      failedOrHeld: 1,
    });
    expect(summary.reviewedAgreement).toEqual({ not_interested: { agreed: 1, corrected: 1 } });
  });
});

function classificationRunRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    property_id: "prop-1",
    conversation_id: "conv-1",
    resolved_outcome: null,
    fallback_reason: "provider_timeout",
    model: "jev-1.13.0",
    schema_version: "2",
    policy_version: "2026-09-20-new-lead-review",
    decision: {},
    created_at: "2026-09-20T00:00:00.000Z",
    properties: { address: "123 Main St", city: "Austin", state: "TX" },
    messages: { body: null },
    ...overrides,
  };
}

describe("getNeedsDecisionQueue — root final-review P1 #3 (classifier_event resolution path)", () => {
  it("surfaces an unpromoted classifier_event (classify failure/unclear) as an actionable item", async () => {
    mocks.classificationRuns = [classificationRunRow()];
    const { items, error } = await getNeedsDecisionQueue();
    expect(error).toBeNull();
    expect(items).toEqual([
      expect.objectContaining({
        id: "run-1",
        source: "classifier_event",
        actionable: true,
        correctionTargets: [],
      }),
    ]);
  });

  it("excludes a classifier_event that has already been promoted to a real jev_lead_decisions row", async () => {
    mocks.classificationRuns = [classificationRunRow({ id: "run-2" })];
    mocks.promotedClassificationRunIds = ["run-2"];
    const { items, error } = await getNeedsDecisionQueue();
    expect(error).toBeNull();
    expect(items).toEqual([]);
  });

  it("surfaces multiple classifier_events, only excluding the ones already promoted", async () => {
    mocks.classificationRuns = [
      classificationRunRow({ id: "run-3", created_at: "2026-09-20T00:00:00.000Z" }),
      classificationRunRow({ id: "run-4", created_at: "2026-09-20T00:01:00.000Z" }),
    ];
    mocks.promotedClassificationRunIds = ["run-3"];
    const { items } = await getNeedsDecisionQueue();
    expect(items.map((i) => i.id)).toEqual(["run-4"]);
  });
});

describe("getCorrectionHistory — root final-review P2 (full sequential correction history, not a single slot)", () => {
  it("returns every correction event for the row, oldest first, not just the most recent", async () => {
    mocks.leadEvents = [
      {
        id: "event-1",
        payload: { review_id: "review-1", corrected_disposition: "nurture", reason: "first guess" },
        actor_id: "user-1",
        created_at: "2026-09-20T00:00:00.000Z",
      },
      {
        id: "event-2",
        payload: { review_id: "review-1", corrected_disposition: "not_interested", reason: "changed mind" },
        actor_id: "user-2",
        created_at: "2026-09-20T01:00:00.000Z",
      },
    ];
    const { entries, error } = await getCorrectionHistory("prop-1", "ai_disposition_review", "review-1");
    expect(error).toBeNull();
    expect(entries).toEqual([
      expect.objectContaining({ id: "event-1", correctedOutcome: "nurture", reason: "first guess", actorId: "user-1" }),
      expect.objectContaining({ id: "event-2", correctedOutcome: "not_interested", reason: "changed mind", actorId: "user-2" }),
    ]);
  });

  it("only returns events matching THIS review/decision id, not other rows' correction events", async () => {
    mocks.leadEvents = [
      { id: "event-1", payload: { review_id: "review-OTHER", corrected_disposition: "nurture" }, actor_id: null, created_at: "2026-09-20T00:00:00.000Z" },
      { id: "event-2", payload: { review_id: "review-1", corrected_disposition: "opted_out" }, actor_id: null, created_at: "2026-09-20T01:00:00.000Z" },
    ];
    const { entries } = await getCorrectionHistory("prop-1", "ai_disposition_review", "review-1");
    expect(entries.map((e) => e.id)).toEqual(["event-2"]);
  });

  it("reads decision_id (not review_id) for a jev_lead_decision source", async () => {
    mocks.leadEvents = [
      { id: "event-1", payload: { decision_id: "decision-1", corrected_outcome: "opted_out", reason: "phone said stop" }, actor_id: "user-1", created_at: "2026-09-20T00:00:00.000Z" },
    ];
    const { entries } = await getCorrectionHistory("prop-1", "jev_lead_decision", "decision-1");
    expect(entries).toEqual([
      expect.objectContaining({ correctedOutcome: "opted_out", reason: "phone said stop" }),
    ]);
  });

  it("returns an empty list (never throws) when there are no corrections yet", async () => {
    mocks.leadEvents = [];
    const { entries, error } = await getCorrectionHistory("prop-1", "ai_disposition_review", "review-1");
    expect(error).toBeNull();
    expect(entries).toEqual([]);
  });
});
