import { parseEscalationReason } from "@/lib/ai-responder/format-reason";

import type { EmailMessage, HoldInfo, HotPromotion } from "./types";

/**
 * Alert copy carries ids, first name, age and a link: never seller message text.
 * The hot-text alert also carries the property address (record data, allowed).
 */

const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The one link every alert carries: the lead's own page (the lead id is the property id). */
export function leadLink(baseUrl: string, propertyId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/leads/${encodeURIComponent(propertyId)}`;
}

const REASON_LABELS: Record<string, string> = {
  price_or_offer: "price talk",
  call_request: "call request",
  distress: "distressed seller",
  multi_property: "multiple properties",
  third_party: "third party involved",
  hot_lead: "hot lead",
  needs_reply: "needs a reply",
  draft_held: "draft held for review",
  reply_pending: "reply pending",
  jev_decision: "Jev flagged it",
  pending_draft: "draft waiting",
  disposition_review: "disposition review",
};

/** Short human reason for a hold, from its reason key. Never message text. */
export function holdReasonLabel(reasonKey: string): string {
  return REASON_LABELS[reasonKey] ?? (parseEscalationReason(reasonKey)?.shortLabel ?? "Needs review").toLowerCase();
}

function where(hold: HoldInfo): string {
  return hold.name;
}

export function formatAge(since: string | null, nowMs: number): string {
  if (!since) return "age unknown";
  const ms = nowMs - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 0) return "age unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function slackFirstText(hold: HoldInfo, baseUrl: string): string {
  return `New hold needs review: ${escapeSlack(where(hold))} (${escapeSlack(hold.reasonLabel)}). ${leadLink(baseUrl, hold.propertyId)}`;
}

export function smsText(hold: HoldInfo, baseUrl: string): string {
  return `Hot hold: ${where(hold)} (${hold.reasonLabel}). ${leadLink(baseUrl, hold.propertyId)}`;
}

/**
 * PLACEHOLDER copy awaiting Jarrad's approval (listed in PR #882). Carries the
 * property address (record data); never seller message text.
 */
export function hotTextHeadline(p: HotPromotion): string {
  return p.address ? `Hot text on your lead: ${p.name}, ${p.address}` : `Hot text on your lead: ${p.name}`;
}

/**
 * Approved verbatim by Jarrad 2026-10-20 (PR #906).
 * Same shape as the hot-text alert; address is record data, never seller text.
 */
export function leadReplyHeadline(p: HotPromotion): string {
  return p.address ? `New text on your lead: ${p.name}, ${p.address}` : `New text on your lead: ${p.name}`;
}

/** ambiguous_thread link: the reply's own conversation, or the unknown-sender list. */
export function ambiguousThreadLink(baseUrl: string, p: HotPromotion): string {
  return `${baseUrl.replace(/\/+$/, "")}${p.linkPath ?? "/messages?filter=unknown"}`;
}

/** Every other kind carries a property; a missing one falls back to the inbox rather than a broken lead link. */
function promotionLink(baseUrl: string, p: HotPromotion): string {
  return p.propertyId ? leadLink(baseUrl, p.propertyId) : ambiguousThreadLink(baseUrl, p);
}

export function hotPromotionSlackText(p: HotPromotion, baseUrl: string): string {
  // Ambiguous thread: the existing hold copy with the existing needs_reply label; no new wording.
  if (p.kind === "ambiguous_thread") return `New hold needs review: ${escapeSlack(p.name)} (${escapeSlack(holdReasonLabel("needs_reply"))}). ${ambiguousThreadLink(baseUrl, p)}`;
  // Routing v2 owner alert: today's hold-alert copy with the approved v2 label.
  if (p.kind === "routing_v2_alert") return `New hold needs review: ${escapeSlack(p.name)} (${escapeSlack(p.label ?? "hold")}). ${promotionLink(baseUrl, p)}`;
  if (p.kind === "selling_opportunity") return `Possible selling opportunity: ${escapeSlack(p.name)} mentioned interest in selling, including a possible referral or another property. Review the conversation; this does not mark the original property for sale. ${promotionLink(baseUrl, p)}`;
  if (p.kind === "lead_reply") return `${escapeSlack(leadReplyHeadline(p))}. ${promotionLink(baseUrl, p)}`;
  // A failed hand-off uses the existing hold alert copy.
  if (p.kind === "hot_failed") return `New hold needs review: ${escapeSlack(p.name)} (${escapeSlack(holdReasonLabel(p.reason ?? "hold"))}). ${promotionLink(baseUrl, p)}`;
  if (p.kind === "hot_text") return `${escapeSlack(hotTextHeadline(p))}. ${promotionLink(baseUrl, p)}`;
  return `Hot seller: ${escapeSlack(p.name)} is now on My Leads under you. ${promotionLink(baseUrl, p)}`;
}

export function hotPromotionSmsText(p: HotPromotion, baseUrl: string): string {
  if (p.kind === "ambiguous_thread") return `Hot hold: ${p.name} (${holdReasonLabel("needs_reply")}). ${ambiguousThreadLink(baseUrl, p)}`;
  if (p.kind === "routing_v2_alert") return `Hot hold: ${p.name} (${p.label ?? "hold"}). ${promotionLink(baseUrl, p)}`;
  if (p.kind === "selling_opportunity") return `Possible selling opportunity from ${p.name}. May be another property or a referral. Review conversation: ${promotionLink(baseUrl, p)}`;
  if (p.kind === "lead_reply") return `${leadReplyHeadline(p)}. ${promotionLink(baseUrl, p)}`;
  if (p.kind === "hot_failed") return `Hot hold: ${p.name} (${holdReasonLabel(p.reason ?? "hold")}). ${promotionLink(baseUrl, p)}`;
  if (p.kind === "hot_text") return `${hotTextHeadline(p)}. ${promotionLink(baseUrl, p)}`;
  return `Hot seller: ${p.name} is now on My Leads under you. ${promotionLink(baseUrl, p)}`;
}

export function digestMessage(holds: readonly HoldInfo[], nowMs: number, baseUrl: string): EmailMessage {
  const lines = holds.map((h) => `- ${where(h)} (${h.reasonLabel}, open ${formatAge(h.since, nowMs)}) ${leadLink(baseUrl, h.propertyId)}`);
  return {
    subject: `${holds.length} open ${holds.length === 1 ? "hold" : "holds"} need review`,
    text: [`Open holds:`, "", ...lines].join("\n"),
  };
}
