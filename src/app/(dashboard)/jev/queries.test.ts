import { describe, expect, it } from "vitest";

import { summarize, type JevQueueItem } from "./queries";

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
