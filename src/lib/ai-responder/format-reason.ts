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

export function parseEscalationReason(
  raw: string | null | undefined,
): ParsedReason | null {
  if (!raw) return null;
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

  return {
    raw,
    gate,
    tier: null,
    color: "amber",
    shortLabel: formatShortLabel(gate),
    longLabel: formatLongLabel(gate, detail) ?? raw,
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
    default:
      return "Needs review";
  }
}
