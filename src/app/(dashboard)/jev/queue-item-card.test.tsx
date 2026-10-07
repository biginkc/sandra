import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { QueueItemCard } from "./queue-item-card";
import type { JevQueueItem } from "./queries";

/**
 * Fable review of 9cd4ec2b (fable-final-review-9cd4ec2b.json,
 * jev-root-round15-fable-fixes.md), finding 3: a promoted classifier
 * event (proposed_outcome 'unclear'/'bad_number' — a placeholder, never
 * a real Jev decision) must never offer "Confirm" — fn_confirm_jev_lead_decision
 * only accepts new_lead/nurture and would otherwise fail with a raw DB
 * constraint error. Only the correction picker (a real supported
 * outcome) should be offered.
 */
vi.mock("./actions", () => ({
  confirmJevQueueItem: vi.fn(),
  correctJevQueueItem: vi.fn(),
  fetchCorrectionHistory: vi.fn(),
  markJevQueueItemReviewed: vi.fn(),
  promoteClassifierEventToDecision: vi.fn(),
}));

function item(overrides: Partial<JevQueueItem> = {}): JevQueueItem {
  return {
    id: "decision-1",
    source: "jev_lead_decision",
    propertyId: "prop-1",
    propertyAddress: "123 Main St",
    conversationId: "conv-1",
    proposedOutcome: "new_lead",
    status: "pending",
    resolvedOutcome: null,
    correctedOutcome: null,
    nativeConfidence: 0.5,
    thresholdAtDecision: 0.9,
    thresholdVersion: 1,
    evidenceBody: "hi",
    createdAt: "2026-09-21T00:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    correctionReason: null,
    humanReviewedAt: null,
    actionable: true,
    applicationState: "not_applied",
    model: "jev-1.13.0",
    schemaVersion: "2",
    policyVersion: "policy-1",
    correctionTargets: ["new_lead", "wrong_number", "not_interested", "nurture", "opted_out", "dnc"],
    ...overrides,
  };
}

describe("<QueueItemCard /> — promoted classifier event Confirm gating (finding 3)", () => {
  it("hides Confirm for a promoted 'unclear' placeholder decision, but still offers the correction picker", () => {
    render(<QueueItemCard item={item({ proposedOutcome: "unclear" })} />);
    expect(screen.queryByTestId("jev-confirm-decision-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("jev-correct-toggle-decision-1")).toBeInTheDocument();
  });

  it("hides Confirm for a promoted 'bad_number' placeholder decision, but still offers the correction picker", () => {
    render(<QueueItemCard item={item({ proposedOutcome: "bad_number" })} />);
    expect(screen.queryByTestId("jev-confirm-decision-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("jev-correct-toggle-decision-1")).toBeInTheDocument();
  });

  it("still shows Confirm for a genuine pending new_lead decision", () => {
    render(<QueueItemCard item={item({ proposedOutcome: "new_lead" })} />);
    expect(screen.getByTestId("jev-confirm-decision-1")).toBeInTheDocument();
  });

  it("still shows Confirm for a genuine pending nurture decision", () => {
    render(<QueueItemCard item={item({ proposedOutcome: "nurture" })} />);
    expect(screen.getByTestId("jev-confirm-decision-1")).toBeInTheDocument();
  });
});
