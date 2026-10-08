import type { EmailMessage, HoldInfo } from "./types";

/** Alert copy carries ids, first name, age and a link only: never seller message text or the property address. */

const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function holdsLink(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/messages-v2`;
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

export function slackFirstText(hold: HoldInfo, link: string): string {
  return `New hold needs review: ${escapeSlack(where(hold))}. ${link}`;
}

export function slackNudgeText(hold: HoldInfo, link: string): string {
  return `Still on hold after 1h: ${escapeSlack(where(hold))}. ${link}`;
}

export function smsText(hold: HoldInfo, link: string): string {
  return `Hot hold: ${where(hold)}. ${link}`;
}

export function digestMessage(holds: readonly HoldInfo[], nowMs: number, link: string): EmailMessage {
  const lines = holds.map((h) => `- ${where(h)} (open ${formatAge(h.since, nowMs)}) ${link}`);
  return {
    subject: `${holds.length} open ${holds.length === 1 ? "hold" : "holds"} need review`,
    text: [`Open holds in Messages v2:`, "", ...lines, "", link].join("\n"),
  };
}
