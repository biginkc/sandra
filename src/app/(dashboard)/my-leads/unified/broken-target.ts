import type { RepSmsComposerTarget } from "../rep-sms-composer";
import type { BrokenItem } from "./contract";

/**
 * Which record a Broken item points at, so the composer can resume / resend / check THAT one (a lead may have several
 * failures). The classifier's refId is the id of: a rep_sms_obligations row (followup_*), a delivery-ledger receipt
 * (text_not_delivered, text_blocked, and usually text_status_unknown) or a messages row (text_not_sent, and
 * text_status_unknown when no receipt exists). text_status_unknown does not say which of the last two, so it is sent as
 * "ledger" and the server falls through to messages by the same uuid; it never guesses by kind.
 */
export function brokenTarget(item: BrokenItem): RepSmsComposerTarget | null {
  if (!item.refId) return null;
  const mode = item.action === "send_text" ? "send" : item.action === "resend" ? "resend" : item.action === "check_status" ? "check" : item.action === "review" ? "review" : null;
  if (!mode) return null;
  switch (item.kind) {
    case "followup_text_not_delivered":
    case "followup_text_blocked":
    case "followup_text_status_unknown":
    case "followup_text_not_sent":
      return { sourceKind: "obligation", refId: item.refId, mode };
    case "text_not_delivered":
    case "text_blocked":
    case "text_status_unknown":
      return { sourceKind: "ledger", refId: item.refId, mode };
    case "text_not_sent":
      return { sourceKind: "message", refId: item.refId, mode };
    default:
      return null;
  }
}

/** Messages v2 (the dead-letter / hold view) opened with this dead letter selected. */
export function messagesDeadLetterHref(refId: string | null, propertyId: string): string {
  return `/messages-v2?${new URLSearchParams(refId ? { deadLetter: refId } : { property: propertyId }).toString()}`;
}

/** The Norma queue's review section opened on this request (or, until the classifier supplies its id, this lead's). */
export function normaReviewHref(refId: string | null, propertyId: string): string {
  return `/norma/queue?${new URLSearchParams(refId ? { request: refId } : { property: propertyId }).toString()}`;
}
