import type {
  InboxReplyStatus,
  PreparedInboxReply,
} from "@/lib/inbox/reply-api-contract";
import { isTerminalReceiptStatus } from "./reply-receipt-policy";

export type ReplyPhase =
  | "ready"
  | "reviewing"
  | "sending"
  | "sent"
  | "blocked"
  | "route_changed"
  | "uncertain"
  | "network_error";

export type ReplyReview = {
  prepared: PreparedInboxReply;
  routeKey: string;
};

export type ReplyState = {
  phase: ReplyPhase;
  draft: string;
  review?: ReplyReview;
  operationId?: string;
  status?: InboxReplyStatus;
  message?: string;
};

export type ReplyEvent =
  | { type: "review_requested"; draft: string }
  | { type: "review_ready"; review: ReplyReview }
  | { type: "review_blocked"; review: ReplyReview; message: string }
  | { type: "network_error"; message: string }
  | { type: "route_changed"; message: string }
  | { type: "send_requested" }
  | { type: "send_started"; operationId: string }
  | { type: "receipt_update"; status: InboxReplyStatus }
  | { type: "receipt"; status: InboxReplyStatus }
  | { type: "uncertain"; message: string; status?: InboxReplyStatus }
  | { type: "edit"; draft: string }
  | { type: "initialize"; state: ReplyState }
  | { type: "reset"; draft?: string };

export const initialReplyState = (draft = ""): ReplyState => ({
  phase: "ready",
  draft,
});

function reviewIsBlocked(review: ReplyReview): boolean {
  return (
    review.prepared.blockers.length > 0 ||
    review.prepared.recipientCount === 0 ||
    !review.prepared.items.some(
      (item) => item.exclusion === null && item.recipient !== null,
    )
  );
}

export function replyStateReducer(
  state: ReplyState,
  event: ReplyEvent,
): ReplyState {
  switch (event.type) {
    case "review_requested":
      return {
        phase: "reviewing",
        draft: event.draft,
        message: undefined,
      };
    case "review_ready":
      return {
        phase: reviewIsBlocked(event.review) ? "blocked" : "reviewing",
        draft: state.draft,
        review: event.review,
        message: reviewIsBlocked(event.review)
          ? "No eligible recipients remain in this review."
          : undefined,
      };
    case "review_blocked":
      return {
        phase: "blocked",
        draft: state.draft,
        review: event.review,
        message: event.message,
      };
    case "network_error":
      return {
        phase: "network_error",
        draft: state.draft,
        review: undefined,
        message: event.message,
      };
    case "route_changed":
      return {
        phase: "route_changed",
        draft: state.draft,
        review: undefined,
        message: event.message,
      };
    case "send_requested":
      return {
        ...state,
        phase: "sending",
        message: undefined,
      };
    case "send_started":
      return {
        ...state,
        phase: "sending",
        operationId: event.operationId,
        message: undefined,
      };
    case "receipt_update":
      return {
        ...state,
        status: event.status,
      };
    case "receipt":
      return {
        ...state,
        // The shared policy is the only receipt-state classifier. A receipt
        // event is expected to be terminal; fail closed if a caller violates
        // that contract (report §(e)).
        phase: isTerminalReceiptStatus(event.status) ? "sent" : "uncertain",
        status: event.status,
        message: undefined,
      };
    case "uncertain":
      return {
        ...state,
        phase: "uncertain",
        status: event.status ?? state.status,
        message: event.message,
      };
    case "edit":
      return {
        phase: "ready",
        draft: event.draft,
      };
    case "initialize":
      return event.state;
    case "reset":
      return initialReplyState(event.draft ?? "");
  }
}
