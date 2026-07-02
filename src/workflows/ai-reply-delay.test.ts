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
});
