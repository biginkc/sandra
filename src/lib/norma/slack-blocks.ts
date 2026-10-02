import type { KnownBlock } from "@slack/types";

import { NORMA_QUALIFICATION_DISPLAY } from "./outcome";
import { normaOutcomeLabel } from "./outcome-labels";

/**
 * Block Kit content for the Norma channel summary. Presents stored call data
 * only: plain labels, no authored script or persuasive copy. The seller's
 * stated callback preference is always marked unconfirmed.
 */
export type NormaSlackSummaryInput = {
  sellerName: string | null;
  propertyAddress: string;
  outcome: string | null;
  summary: string | null;
  qualification: Record<string, unknown>;
  callbackPreference: string | null;
  /** Converted time, already formatted in the seller's zone (see `formatNormaCallbackTime`). Still unconfirmed. */
  callbackTime?: string | null;
  deepLink: string;
};

const SECTION_MAX = 2900;
const HEADER_MAX = 150;

/** Slack mrkdwn control characters in seller-supplied text. */
export function escapeSlackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(value: string, max = SECTION_MAX): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function readQualification(qualification: Record<string, unknown>, variable: string): string | null {
  const value = qualification[variable];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The stored summary also embeds the qualification answers; drop those lines so they are not shown twice. */
function summaryWithoutQualificationLines(summary: string | null): string | null {
  if (!summary) return null;
  const prefixes = NORMA_QUALIFICATION_DISPLAY.map(({ label }) => `${label}:`.toLowerCase());
  const lines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !prefixes.some((prefix) => line.toLowerCase().startsWith(prefix)));
  return lines.length ? lines.join("\n") : null;
}

export function buildNormaSummaryBlocks(input: NormaSlackSummaryInput): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: clip(`Norma call: ${normaOutcomeLabel(input.outcome)}`, HEADER_MAX), emoji: false },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: clip(
          `*Seller:* ${escapeSlackText(input.sellerName?.trim() || "Unknown")}\n*Property:* ${escapeSlackText(input.propertyAddress)}`,
        ),
      },
    },
  ];

  for (const { label, variable } of NORMA_QUALIFICATION_DISPLAY) {
    const value = readQualification(input.qualification, variable);
    if (value) blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(`*${label}:* ${escapeSlackText(value)}`) } });
  }

  const summary = summaryWithoutQualificationLines(input.summary);
  if (summary) blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(`*Call summary:* ${escapeSlackText(summary)}`) } });

  if (input.callbackPreference?.trim()) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: clip(`*Seller's stated callback preference (unconfirmed):* ${escapeSlackText(input.callbackPreference.trim())}`),
      },
    });
  }

  if (input.callbackTime?.trim()) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: clip(`*Converted callback time (unconfirmed):* ${escapeSlackText(input.callbackTime.trim())}`) },
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `<${input.deepLink}|Open lead in Sandra>` }],
  });
  return blocks;
}

/** Plain-text fallback for notifications and clients that do not render blocks. */
export function buildNormaSummaryFallbackText(input: Pick<NormaSlackSummaryInput, "outcome" | "propertyAddress">): string {
  return `Norma call: ${normaOutcomeLabel(input.outcome)} (${escapeSlackText(input.propertyAddress)})`;
}

/** Same base-URL resolution the existing Slack task links use. */
export function buildNormaLeadDeepLink(propertyId: string, env: Record<string, string | undefined> = process.env): string {
  const baseUrl = env.NEXT_PUBLIC_APP_URL ?? env.APP_URL ?? "https://sandra-sooty.vercel.app";
  const normalized = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  return `${normalized.replace(/\/+$/, "")}/leads/${propertyId}`;
}
