import type { ConsentState } from "@/lib/messaging/consent";

import type { SkipDecision } from "./types";

/**
 * Pre-Claude-call skip classifier.
 *
 * Runs BEFORE we call Claude. If any gate returns a skip reason, we
 * don't even generate a reply — we either escalate (property gets
 * flagged) or drop silently (opt-out / disabled) depending on the
 * reason. Keeping this layer pure + cheap lets us short-circuit the
 * expensive Claude call for 90% of inbound traffic (STOP replies,
 * paused sequences, after-hours messages, etc.).
 *
 * Pure function — no DB, no time source beyond what the caller passes in.
 */
export type SkipInput = {
  /** Present when an `ai_responder_configs` row exists and is active. */
  config: {
    active: boolean;
    business_hours_only: boolean;
    max_turns: number;
  } | null;
  /** Current effective consent state on the contact. */
  consentState: ConsentState;
  /** Whether this specific property has `ai_responder_disabled=true`. */
  propertyDisabled: boolean;
  /** Count of AI-generated messages already in this thread today. */
  currentTurn: number;
  /** Is the current moment inside the property's 08:00–21:00 window? */
  withinBusinessHours: boolean;
};

export function classifyAiSkip(input: SkipInput): SkipDecision {
  if (!input.config) return { skip: true, reason: "no_config" };
  if (!input.config.active) return { skip: true, reason: "disabled_org_wide" };

  // Block only explicit opt-outs. Cold contacts (no_consent) and
  // informational-only contacts can still receive an AI reply — mirrors
  // the outbound gate which was also relaxed for cold outreach.
  if (input.consentState === "opted_out") {
    return { skip: true, reason: "no_consent" };
  }

  if (input.propertyDisabled) {
    return { skip: true, reason: "disabled_per_property" };
  }

  // No org-wide volume cap — provider/API credits are the only cap
  // (Jarrad's standing rule). Per-thread max_turns stays: it's a
  // conversation-quality escalation gate, not a volume cap.
  if (input.currentTurn >= input.config.max_turns) {
    return { skip: true, reason: "max_turns_reached" };
  }

  if (input.config.business_hours_only && !input.withinBusinessHours) {
    return { skip: true, reason: "outside_business_hours" };
  }

  return { skip: false };
}
