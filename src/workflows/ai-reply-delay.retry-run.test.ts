import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sleep: vi.fn(async () => undefined),
  dispatch: vi.fn(),
  recordStep: vi.fn(async () => undefined),
  finishRunFromOutcome: vi.fn(async () => undefined),
  resumeRun: vi.fn(async () => ({ runId: "run-1", orgId: "org-1", seq: 3 })),
}));
vi.mock("workflow", () => ({ sleep: h.sleep }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/ai-responder/dispatch", () => ({ dispatchAiResponse: h.dispatch }));
vi.mock("@/lib/messages/ai-responder-thread-state", () => ({
  recordAiResponderOutcomeForThread: vi.fn(async () => undefined),
}));
vi.mock("@/lib/messaging/inbound-state", () => ({ markInboundMessageState: vi.fn(async () => undefined) }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/pipeline-runs", () => ({
  recordStep: h.recordStep,
  finishRunFromOutcome: h.finishRunFromOutcome,
  resumeRun: h.resumeRun,
}));

import { aiReplyDelayWorkflow } from "./ai-reply-delay";

describe("aiReplyDelayWorkflow keeps the pipeline run open across a retry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records a retry_scheduled step, leaves the run running, and finishes it only on the terminal outcome", async () => {
    h.dispatch
      .mockResolvedValueOnce({ outcome: "retry", reason: "draft_persist_failed", attempt: 1, delaySeconds: 20 })
      .mockResolvedValueOnce({ outcome: "escalated", reason: "draft_held" });

    await aiReplyDelayWorkflow({
      propertyId: "p1",
      contactId: "c1",
      conversationId: "conv-1",
      inboundBody: "hi",
      inboundMessageId: "m1",
      delaySeconds: 0,
      runId: "run-1",
    });

    expect(h.recordStep).toHaveBeenCalledTimes(1);
    expect(h.recordStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: "run-1" }),
      expect.objectContaining({
        kind: "action",
        name: "retry_scheduled",
        detail: expect.objectContaining({ reason: "draft_persist_failed", attempt: 1, delaySeconds: 20 }),
      }),
    );
    expect(h.finishRunFromOutcome).toHaveBeenCalledTimes(1);
    expect(h.finishRunFromOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { outcome: "escalated", reason: "draft_held" },
    );
    expect(h.sleep).toHaveBeenCalledWith("20s");
  });
});
