import type { EscalationTier } from "./types";

export type ReasonColor = "sky" | "emerald" | "violet" | "rose" | "amber";

export type ParsedReason = {
  raw: string;
  gate: string;
  tier: EscalationTier | null;
  color: ReasonColor;
  shortLabel: string;
  longLabel: string;
};

const TIER_LABEL: Record<EscalationTier, string> = {
  handoff_request: "Wants human",
  price_offer: "Price offer",
  legal_contract: "Legal/Contract",
  distressed_seller: "Distressed",
};

const TIER_COLOR: Record<EscalationTier, ReasonColor> = {
  handoff_request: "sky",
  price_offer: "emerald",
  legal_contract: "violet",
  distressed_seller: "rose",
};

const VALID_TIERS = new Set<string>([
  "handoff_request",
  "price_offer",
  "legal_contract",
  "distressed_seller",
]);

const SUPPRESSION_REASON_PREFIX = "suppression_incomplete:";

/** Every failed review id carried in a `suppression_incomplete:<idA>,<idB>` reason. */
export function suppressionReviewIdsFromReason(
  reason: string | null | undefined,
): string[] {
  if (!reason || !reason.startsWith(SUPPRESSION_REASON_PREFIX)) return [];
  const ids = reason
    .slice(SUPPRESSION_REASON_PREFIX.length)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

export function parseEscalationReason(
  raw: string | null | undefined,
): ParsedReason | null {
  if (!raw) return null;
  // The orphan scan rewrites an unreadable timeout flag to this value; it is
  // still the send_timeout gate, with its own label.
  if (raw === "send_timeout_unparseable") {
    return {
      raw,
      gate: "send_timeout",
      tier: null,
      color: "amber",
      shortLabel: formatShortLabel("send_timeout"),
      longLabel: "Reply timed out at the provider — record unreadable, needs review",
    };
  }
  const [gate, ...rest] = raw.split(":");
  const detail = rest.join(":");

  if (gate === "keyword" && VALID_TIERS.has(detail)) {
    const tier = detail as EscalationTier;
    return {
      raw,
      gate,
      tier,
      color: TIER_COLOR[tier],
      shortLabel: TIER_LABEL[tier],
      longLabel: `keyword match (${detail.replace(/_/g, " ")})`,
    };
  }

  // Account-level provider failures (dead credits / dead key) take the
  // loudest color: they mean the responder is down for EVERY lead, not
  // just this conversation.
  const color: ReasonColor =
    gate === "provider_billing" ||
    gate === "provider_auth" ||
    gate === "suppression_incomplete" ||
    gate === "dead_letter_failed"
      ? "rose"
      : "amber";

  return {
    raw,
    gate,
    tier: null,
    color,
    shortLabel: formatShortLabel(gate),
    longLabel:
      (gate === "suppression_incomplete" &&
      suppressionReviewIdsFromReason(raw).length > 1
        ? `${suppressionReviewIdsFromReason(raw).length} confirmed opt-outs saved, but the numbers may not be suppressed yet - retry suppression`
        : formatLongLabel(gate, detail)) ?? raw,
  };
}

function formatLongLabel(gate: string, detail: string): string | null {
  switch (gate) {
    case "keyword":
      return `keyword match${detail ? ` (${detail.replace(/_/g, " ")})` : ""}`;
    case "sentiment":
      return `seller sounded ${detail || "off"}`;
    case "low_confidence":
      return `model unsure (${detail || "below threshold"})`;
    case "safety":
      return `unsafe reply blocked (${detail.replace(/_/g, " ")})`;
    case "model":
      return `model chose to escalate${detail ? `: ${detail}` : ""}`;
    case "send_blocked":
      return `send pipeline blocked (${detail.replace(/_/g, " ")})`;
    case "generate_error":
      return "model call failed";
    case "dead_letter_failed":
      if (detail.startsWith("send_timeout")) {
        return "Reply timed out at the provider AND its text could not be saved - check the pipeline run";
      }
      return `reply could not be sent AND its text could not be saved (${detail.replace(/[:_]/g, " ")}) - check the pipeline run`;
    case "send_timeout":
      return "Reply timed out at the provider — held for review";
    case "send_timeout_then_sent":
      return "Reply accepted by provider late — do not re-send";
    case "suppression_incomplete":
      return "Confirmed opt-out saved, but the number may not be suppressed yet - retry suppression";
    case "provider_billing":
      return "Anthropic credits exhausted - AI responder down until topped up";
    case "provider_auth":
      return "Anthropic API key rejected - AI responder down until fixed";
    default:
      return null;
  }
}

function formatShortLabel(gate: string): string {
  switch (gate) {
    case "keyword":
      return "Keyword";
    case "sentiment":
      return "Sentiment";
    case "low_confidence":
      return "Low confidence";
    case "safety":
      return "Safety blocked";
    case "model":
      return "Model escalated";
    case "send_blocked":
      return "Send blocked";
    case "generate_error":
      return "AI error";
    case "dead_letter_failed":
      return "Reply text not saved";
    case "send_timeout":
      return "Send timed out";
    case "send_timeout_then_sent":
      return "Sent late";
    case "suppression_incomplete":
      return "Suppression incomplete";
    case "provider_billing":
      return "API credits out";
    case "provider_auth":
      return "API key dead";
    default:
      return "Needs review";
  }
}
