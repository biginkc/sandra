import { beforeEach, describe, expect, it, vi } from "vitest";

const { sleep } = vi.hoisted(() => ({
  sleep: vi.fn(async () => undefined),
}));
vi.mock("workflow", () => ({ sleep }));

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

const { dispatchAiResponse } = vi.hoisted(() => ({
  dispatchAiResponse: vi.fn(),
}));
vi.mock("@/lib/ai-responder/dispatch", () => ({
  dispatchAiResponse,
  inboundStampOutcomeOf: (o: { outcome: string }) => o.outcome,
}));

const { recordAiResponderOutcomeForThread } = vi.hoisted(() => ({
  recordAiResponderOutcomeForThread: vi.fn(async () => undefined),
}));
vi.mock("@/lib/messages/ai-responder-thread-state", () => ({
  recordAiResponderOutcomeForThread,
}));

const { markInboundMessageState } = vi.hoisted(() => ({
  markInboundMessageState: vi.fn(async () => undefined),
}));
vi.mock("@/lib/messaging/inbound-state", () => ({ markInboundMessageState }));

const { Anthropic } = vi.hoisted(() => ({
  Anthropic: vi.fn(),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: Anthropic }));

import { aiReplyDelayWorkflow, type AiReplyDelayParams } from "./ai-reply-delay";

const params: AiReplyDelayParams = {
  propertyId: "property-1",
  contactId: "contact-1",
  conversationId: "conversation-1",
  inboundFromPhone: "+18165550001",
  inboundToPhone: "+15551234567",
  inboundBody: "tell me more",
  inboundMessageId: "message-1",
  delaySeconds: 12,
};

describe("aiReplyDelayWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAdminClient.mockReturnValue({ from: vi.fn() });
    dispatchAiResponse.mockResolvedValue({
      outcome: "sent",
      messageId: "outbound-1",
      confidence: 0.9,
    });
  });

  it("sleeps for the requested delay before dispatching and stamping terminal state", async () => {
    await aiReplyDelayWorkflow(params);

    expect(sleep).toHaveBeenCalledWith("12s");
    expect(dispatchAiResponse).toHaveBeenCalledWith(
      expect.anything(),
      {
        propertyId: "property-1",
        contactId: "contact-1",
        conversationId: "conversation-1",
        inboundFromPhone: "+18165550001",
        inboundToPhone: "+15551234567",
        inboundBody: "tell me more",
        inboundMessageId: "message-1",
      },
      { anthropic: expect.any(Anthropic), checkSuperseded: true },
    );
    expect(recordAiResponderOutcomeForThread).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: "conversation-1",
        outcome: {
          outcome: "sent",
          messageId: "outbound-1",
          confidence: 0.9,
        },
      }),
    );
    expect(markInboundMessageState).toHaveBeenCalledWith(
      expect.anything(),
      "message-1",
      {
        aiResponder: expect.objectContaining({
          outcome: "sent",
          messageId: "outbound-1",
          confidence: 0.9,
          completedAt: expect.any(String),
        }),
      },
    );
  });

  it("does not call sleep when the delay is zero", async () => {
    await aiReplyDelayWorkflow({ ...params, delaySeconds: 0 });

    expect(sleep).not.toHaveBeenCalled();
    expect(dispatchAiResponse).toHaveBeenCalledTimes(1);
  });

  describe("retry of a contended / failed reply", () => {
    const retry = (attempt: number) => ({
      outcome: "retry" as const,
      reason: "send_reserved_elsewhere" as const,
      attempt,
      delaySeconds: 20,
    });

    it("does NOT finalize on a retry outcome: sleeps 20s, re-dispatches the same inbound with retryAttempt, finalizes once", async () => {
      dispatchAiResponse
        .mockResolvedValueOnce(retry(1))
        .mockResolvedValueOnce(retry(2))
        .mockResolvedValueOnce({ outcome: "sent", messageId: "outbound-9", confidence: 0.9 });

      const result = await aiReplyDelayWorkflow(params);

      expect(result).toMatchObject({ outcome: "sent", messageId: "outbound-9" });
      expect((sleep.mock.calls as unknown[][]).map((c) => c[0])).toEqual(["12s", "20s", "20s"]);
      expect(dispatchAiResponse).toHaveBeenCalledTimes(3);
      const attempts = dispatchAiResponse.mock.calls.map((c) => c[1].retryAttempt);
      expect(attempts).toEqual([undefined, 1, 2]);
      for (const call of dispatchAiResponse.mock.calls) {
        expect(call[1].inboundMessageId).toBe("message-1");
      }
      // Only the final, terminal outcome is stamped on the thread and the inbound.
      expect(recordAiResponderOutcomeForThread).toHaveBeenCalledTimes(1);
      expect(markInboundMessageState).toHaveBeenCalledTimes(1);
      expect(markInboundMessageState).toHaveBeenCalledWith(
        expect.anything(),
        "message-1",
        { aiResponder: expect.objectContaining({ outcome: "sent" }) },
      );
    });

    it("a retry outcome alone never stamps a terminal state or finishes the run", async () => {
      dispatchAiResponse
        .mockResolvedValueOnce(retry(1))
        .mockResolvedValueOnce({ outcome: "escalated", reason: "send_reserved_elsewhere" });
      await aiReplyDelayWorkflow({ ...params, delaySeconds: 0 });
      expect(markInboundMessageState).toHaveBeenCalledTimes(1);
      expect(markInboundMessageState).toHaveBeenCalledWith(
        expect.anything(),
        "message-1",
        { aiResponder: expect.objectContaining({ outcome: "escalated", reason: "send_reserved_elsewhere" }) },
      );
    });

    it("carries the generated reply from each retry outcome into the next dispatch (and from the workflow params into the first)", async () => {
      const reply = { body: "Hi there", confidence: 0.9, sentiment: "neutral", orgId: "org-1", kind: "send_reply" };
      dispatchAiResponse
        .mockResolvedValueOnce({ ...retry(1), reply })
        .mockResolvedValueOnce({ outcome: "sent", messageId: "outbound-1", confidence: 0.9 });
      await aiReplyDelayWorkflow(params);
      expect(dispatchAiResponse.mock.calls[0]![1].retryReply).toBeUndefined();
      expect(dispatchAiResponse.mock.calls[1]![1].retryReply).toEqual(reply);

      dispatchAiResponse.mockClear();
      await aiReplyDelayWorkflow({ ...params, retryAttempt: 2, retryReply: reply as never });
      expect(dispatchAiResponse.mock.calls[0]![1].retryReply).toEqual(reply);
    });

    it("a workflow started AS a retry passes its retryAttempt to the first dispatch", async () => {
      await aiReplyDelayWorkflow({ ...params, delaySeconds: 20, retryAttempt: 2 });
      expect(dispatchAiResponse.mock.calls[0]![1].retryAttempt).toBe(2);
    });
  });
});
