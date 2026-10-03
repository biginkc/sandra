import type { KnownBlock } from "@slack/types";

import {
  SLACK_PREVIEW_TIMEZONE_FALLBACK,
  type SlackLeadPreview,
  type SlackPreviewMessage,
} from "./unfurl-types";

export type {
  SlackLeadPreview,
  SlackLeadPreviewSnapshot,
  SlackPreviewAttempt,
  SlackPreviewMessage,
} from "./unfurl-types";

const CANONICAL_MY_LEADS_ORIGIN = "https://sandra.bmhgroupkc.com";
const HEADER_MAX = 150;
const SECTION_TEXT_MAX = 3000;
const SECTION_FIELD_MAX = 2000;
const BUTTON_TEXT_MAX = 75;
const URL_MAX = 3000;
const EXCERPT_MAX = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MY_LEADS_ATTEMPT_LABELS: Record<string, string> = {
  no_answer: "No answer",
  reached: "Reached",
  wrong_number: "Wrong number",
};
const MESSAGES_DISPO_LABELS: Record<string, string> = {
  wrong_number: "Wrong #",
  bad_number: "Bad / disconnected #",
  not_interested: "Not interested",
  needs_sequence: "Needs drip",
  opted_out: "SMS opted out",
  dnc: "Do not call",
  nurture: "Follow up",
  callback_requested: "Lead task requested",
  booked_appointment: "Booked appointment",
};

function truncate(text: string, maxCodePoints: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= maxCodePoints
    ? text
    : `${codePoints.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…`;
}

function normalize(text: string | null | undefined): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function displayValue(value: string | null | undefined, fallback: string): string {
  return normalize(value) || fallback;
}

function field(label: string, value: string): { type: "plain_text"; text: string; emoji: true } {
  return {
    type: "plain_text",
    text: truncate(`${label}\n${value}`, SECTION_FIELD_MAX),
    emoji: true,
  };
}

function formatAttemptOutcome(attempt: SlackLeadPreview["latestAttempt"]): string {
  if (!attempt) return "No attempts recorded";
  const value = normalize(attempt.outcome);
  if (!value) return "Outcome pending";
  return MY_LEADS_ATTEMPT_LABELS[value] ?? value;
}

function formatMessagesDisposition(disposition: string | null | undefined): string {
  const value = normalize(disposition);
  if (!value) return "No disposition recorded";
  return MESSAGES_DISPO_LABELS[value] ?? value;
}

function formatDate(value: string | null | undefined, timezone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "No successful contact recorded";
  let resolvedTimeZone = SLACK_PREVIEW_TIMEZONE_FALLBACK;
  const candidateTimeZone = typeof timezone === "string" && timezone.trim()
    ? timezone.trim()
    : SLACK_PREVIEW_TIMEZONE_FALLBACK;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidateTimeZone }).format();
    resolvedTimeZone = candidateTimeZone;
  } catch {
    // A malformed stored zone must not fall back to server-local time.
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: resolvedTimeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function attachmentLabel(count: number): string {
  return `${count} ${count === 1 ? "attachment" : "attachments"}`;
}

function messageExcerpt(message: SlackPreviewMessage): string {
  const body = normalize(message.body);
  if (body) return truncate(body, EXCERPT_MAX);
  if (message.attachmentCount > 0) return attachmentLabel(message.attachmentCount);
  return "No text content";
}

function messageLine(message: SlackPreviewMessage): string {
  const sender = message.direction === "outbound" ? "Us" : "Them";
  const notDelivered =
    message.direction === "outbound" &&
    ["failed", "bounced"].includes(normalize(message.deliveryStatus).toLowerCase());
  return `${sender}: ${messageExcerpt(message)}${notDelivered ? " · Not delivered" : ""}`;
}

export function canonicalPreviewUrl(propertyId: string): string {
  if (!UUID.test(propertyId)) throw new Error("Invalid lead id for Slack preview URL");
  return `${CANONICAL_MY_LEADS_ORIGIN}/my-leads?lead=${propertyId.toLowerCase()}`;
}

export function buildPreviewBlocks(snapshot: SlackLeadPreview): KnownBlock[] {
  const heading = displayValue(
    snapshot.leadName ?? snapshot.address,
    "Unnamed lead",
  );
  const messages = snapshot.messages.slice(-3).map(messageLine);
  const messageStrip = messages.length > 0 ? messages.join(" → ") : "No texts yet";

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncate(`Lead preview: ${heading}`, HEADER_MAX),
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        field("Lead", displayValue(snapshot.leadName, "Name unavailable")),
        field("Address", displayValue(snapshot.address, "Address unavailable")),
        field(
          "Owner",
          displayValue(
            snapshot.ownerName,
            snapshot.ownerAssigned ? "Owner unavailable" : "Unassigned",
          ),
        ),
        field("My Leads attempt", formatAttemptOutcome(snapshot.latestAttempt)),
        field(
          "Messages disposition",
          formatMessagesDisposition(snapshot.messagesDisposition),
        ),
        field("Last contact", formatDate(snapshot.lastContactAt, snapshot.timezone)),
      ],
    },
    {
      type: "section",
      text: {
        type: "plain_text",
        text: truncate(messageStrip, SECTION_TEXT_MAX),
        emoji: true,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: truncate("Open in My Leads", BUTTON_TEXT_MAX),
            emoji: true,
          },
          url: truncate(canonicalPreviewUrl(snapshot.propertyId), URL_MAX),
          action_id: "open_my_leads",
        },
      ],
    },
  ];
}
