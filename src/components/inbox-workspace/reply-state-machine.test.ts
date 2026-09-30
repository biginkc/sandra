import { describe, expect, it } from "vitest";
import type { InboxReplyStatus, PreparedInboxReply } from "@/lib/inbox/reply-api-contract";
import { initialReplyState, replyStateReducer, type ReplyReview } from "./reply-state-machine";

const prepared = (overrides: Partial<PreparedInboxReply> = {}): PreparedInboxReply => ({
  preparationId: "00000000-0000-4000-8000-000000000001",
  idempotencyKey: "00000000-0000-4000-8000-000000000002",
  inputHash: "a".repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  items: [{
    id: "00000000-0000-4000-8000-000000000003",
    target: { kind: "conversation", id: "00000000-0000-4000-8000-000000000004" },
    exclusion: null,
    duplicateDestination: false,
    recipient: {
      contactName: "Ada Lovelace",
      propertyAddress: "123 Oak St",
      propertyId: "00000000-0000-4000-8000-000000000005",
      contactId: "00000000-0000-4000-8000-000000000006",
      from: "+18165550100",
      to: "+18165550142",
      renderedBody: "Hello Ada",
    },
  }],
  recipientCount: 1,
  blockers: [],
  ...overrides,
});
const review = (value = prepared()): ReplyReview => ({ prepared: value, routeKey: "route-1" });

const status = (state: InboxReplyStatus): InboxReplyStatus => state;

describe("review-before-send state machine", () => {
  it("moves from ready to reviewing without accepting a send", () => {
    const state = replyStateReducer(initialReplyState("Hello"), { type: "review_requested", draft: "Hello" });
    expect(state.phase).toBe("reviewing");
    expect(state.review).toBeUndefined();
  });

  it("keeps a valid review in reviewing until send is explicitly requested", () => {
    const state = replyStateReducer(
      replyStateReducer(initialReplyState("Hello"), { type: "review_requested", draft: "Hello" }),
      { type: "review_ready", review: review() },
    );
    expect(state.phase).toBe("reviewing");
    expect(state.review?.prepared.recipientCount).toBe(1);
  });

  it("enters sending only after the review send action", () => {
    const reviewing = replyStateReducer(initialReplyState("Hello"), { type: "review_ready", review: review() });
    expect(replyStateReducer(reviewing, { type: "send_requested" }).phase).toBe("sending");
  });

  it("enters sent only from a terminal receipt", () => {
    const state = replyStateReducer(
      { ...initialReplyState("Hello"), phase: "sending", operationId: "operation-1", review: review() },
      { type: "receipt", status: status({
        operationId: "operation-1", preparationId: "00000000-0000-4000-8000-000000000001", dispatchComplete: true,
        items: prepared().items, receipts: [{ itemId: prepared().items[0].id, attemptId: null, version: "1", state: "delivered", reason: null }],
      }) },
    );
    expect(state.phase).toBe("sent");
  });

  it.each(["pending", "dispatch_started", "uncertain"] as const)(
    "classifies a %s receipt as uncertain and never as sent",
    (receiptState) => {
      // MUTATION M3 GUARD: forcing receipt handling to "sent" must fail every case here.
      const state = replyStateReducer(
        { ...initialReplyState("Hello"), phase: "sending", operationId: "operation-1", review: review() },
        { type: "receipt", status: status({
          operationId: "operation-1", preparationId: "00000000-0000-4000-8000-000000000001", dispatchComplete: false,
          items: prepared().items, receipts: [{ itemId: prepared().items[0].id, attemptId: null, version: "1", state: receiptState, reason: null }],
        }) },
      );
      expect(state.phase).toBe("uncertain");
      expect(state.phase).not.toBe("sent");
    },
  );

  it("blocks every exclusion code without creating a sendable review", () => {
    const codes = [
      "unsupported_target", "conversation_unavailable", "property_unavailable", "property_suppressed",
      "contact_mapping_unavailable", "contact_suppressed", "inbound_unavailable", "conversation_changed",
      "inbound_mapping_changed", "reply_route_unavailable", "phone_not_saved", "landline", "unclassified_phone",
      "sms_suppressed", "no_consent", "sender_unavailable", "context_unavailable", "conversation_window_expired",
      "unknown_state", "outside_window", "missing_variable", "invalid_template", "invalid_body", "contact_unavailable",
    ] as const;
    for (const code of codes) {
      const value = prepared({ items: [{ ...prepared().items[0], exclusion: code, recipient: null }], recipientCount: 0 });
      const state = replyStateReducer(initialReplyState("Hello"), { type: "review_blocked", review: review(value), message: `Blocked: ${code}` });
      expect(state.phase, code).toBe("blocked");
      expect(state.review?.prepared.items[0].exclusion, code).toBe(code);
    }
  });

  it("discards the frozen review when the route changes", () => {
    const state = replyStateReducer({ ...initialReplyState("Hello"), phase: "reviewing", review: review() }, { type: "route_changed", message: "The route changed. Review again." });
    expect(state.phase).toBe("route_changed");
    expect(state.review).toBeUndefined();
    expect(state.draft).toBe("Hello");
  });

  it("keeps an uncertain send non-resendable", () => {
    const state = replyStateReducer({ ...initialReplyState("Hello"), phase: "sending", operationId: "operation-1", review: review() }, { type: "uncertain", message: "Do not resend." });
    expect(state.phase).toBe("uncertain");
    expect(state.operationId).toBe("operation-1");
  });

  it("keeps network errors separate from a committed-but-unknown send", () => {
    const state = replyStateReducer(initialReplyState("Hello"), { type: "network_error", message: "Review could not be loaded." });
    expect(state.phase).toBe("network_error");
    expect(state.review).toBeUndefined();
  });
});
