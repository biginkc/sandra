import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  order: [] as string[],
  sleep: vi.fn(async () => undefined),
  dispatch: vi.fn(),
  shadow: vi.fn(),
  markState: vi.fn(async () => {
    m.order.push("stamp");
  }),
  finishRun: vi.fn(async () => {
    m.order.push("finish");
  }),
}));
vi.mock("workflow", () => ({ sleep: m.sleep }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({ from: vi.fn() })) }));
vi.mock("@/lib/ai-responder/dispatch", () => ({
  dispatchAiResponse: m.dispatch,
  inboundStampOutcomeOf: (o: { outcome: string }) => o.outcome,
}));
vi.mock("@/lib/messages/ai-responder-thread-state", () => ({ recordAiResponderOutcomeForThread: vi.fn(async () => undefined) }));
vi.mock("@/lib/messaging/inbound-state", () => ({ markInboundMessageState: m.markState }));
vi.mock("@/lib/pipeline-runs", () => ({ resumeRun: vi.fn(async () => null), finishRunFromOutcome: m.finishRun }));
vi.mock("@/lib/ai-responder/retry", () => ({
  isRetryOutcome: (o: { outcome: string }) => o.outcome === "retry",
  recordRetryScheduled: vi.fn(async () => undefined),
}));
vi.mock("@/lib/sms-classification/routing-v2/shadow", () => ({ runRoutingV2Shadow: m.shadow }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));

import { aiReplyDelayWorkflow, type AiReplyDelayParams } from "./ai-reply-delay";

const params: AiReplyDelayParams = {
  propertyId: "property-1",
  contactId: "contact-1",
  conversationId: "conversation-1",
  inboundBody: "call me tomorrow",
  inboundMessageId: "message-1",
  delaySeconds: 5,
};

describe("aiReplyDelayWorkflow routing v2 shadow step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.order.length = 0;
    m.dispatch.mockResolvedValue({ outcome: "sent", messageId: "out-1" });
    m.shadow.mockImplementation(async () => {
      m.order.push("shadow");
      return "decided";
    });
  });

  it("runs the shadow only after the run is finished and the inbound is stamped, with the live outcome and ids", async () => {
    await aiReplyDelayWorkflow(params);
    expect(m.order).toEqual(["finish", "stamp", "shadow"]);
    expect(m.shadow.mock.calls[0][1]).toEqual({
      propertyId: "property-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      inboundMessageId: "message-1",
      inboundBody: "call me tomorrow",
      liveOutcome: "sent",
    });
  });

  it("a hanging shadow cannot hold the live stamping: finish + stamp complete first", async () => {
    m.shadow.mockImplementation(() => new Promise(() => {}));
    void aiReplyDelayWorkflow(params);
    await vi.waitFor(() => expect(m.shadow).toHaveBeenCalledTimes(1));
    expect(m.finishRun).toHaveBeenCalledTimes(1);
    expect(m.markState).toHaveBeenCalledTimes(1);
  });

  it("a throwing shadow does not fail the workflow or change the live outcome", async () => {
    m.shadow.mockRejectedValue(new Error("shadow blew up"));
    await expect(aiReplyDelayWorkflow(params)).resolves.toEqual({ outcome: "sent", messageId: "out-1" });
    expect(m.markState).toHaveBeenCalledTimes(1);
  });

  it("retries are not shadowed: one shadow, after the terminal outcome only", async () => {
    m.dispatch
      .mockResolvedValueOnce({ outcome: "retry", attempt: 1, delaySeconds: 10 })
      .mockResolvedValueOnce({ outcome: "sent", messageId: "out-1" });
    await aiReplyDelayWorkflow(params);
    expect(m.dispatch).toHaveBeenCalledTimes(2);
    expect(m.shadow).toHaveBeenCalledTimes(1);
    expect(m.order).toEqual(["finish", "stamp", "shadow"]);
  });
});
