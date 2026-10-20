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

export function hotPromotionSlackText(p: HotPromotion, baseUrl: string): string {
  if (p.kind === "lead_reply") return `${escapeSlack(leadReplyHeadline(p))}. ${leadLink(baseUrl, p.propertyId)}`;
  // A failed hand-off uses the existing hold alert copy.
  if (p.kind === "hot_failed") return `New hold needs review: ${escapeSlack(p.name)} (${escapeSlack(holdReasonLabel(p.reason ?? "hold"))}). ${leadLink(baseUrl, p.propertyId)}`;
  if (p.kind === "hot_text") return `${escapeSlack(hotTextHeadline(p))}. ${leadLink(baseUrl, p.propertyId)}`;
  return `Hot seller: ${escapeSlack(p.name)} is now on My Leads under you. ${leadLink(baseUrl, p.propertyId)}`;
}

export function hotPromotionSmsText(p: HotPromotion, baseUrl: string): string {
  if (p.kind === "lead_reply") return `${leadReplyHeadline(p)}. ${leadLink(baseUrl, p.propertyId)}`;
  if (p.kind === "hot_failed") return `Hot hold: ${p.name} (${holdReasonLabel(p.reason ?? "hold")}). ${leadLink(baseUrl, p.propertyId)}`;
  if (p.kind === "hot_text") return `${hotTextHeadline(p)}. ${leadLink(baseUrl, p.propertyId)}`;
  return `Hot seller: ${p.name} is now on My Leads under you. ${leadLink(baseUrl, p.propertyId)}`;
}

export function digestMessage(holds: readonly HoldInfo[], nowMs: number, baseUrl: string): EmailMessage {
  const lines = holds.map((h) => `- ${where(h)} (${h.reasonLabel}, open ${formatAge(h.since, nowMs)}) ${leadLink(baseUrl, h.propertyId)}`);
  return {
    subject: `${holds.length} open ${holds.length === 1 ? "hold" : "holds"} need review`,
    text: [`Open holds:`, "", ...lines].join("\n"),
  };
}
