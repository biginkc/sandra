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
    daily_send_cap: number;
  } | null;
  /** Current effective consent state on the contact. */
  consentState: ConsentState;
  /** Whether this specific property has `ai_responder_disabled=true`. */
  propertyDisabled: boolean;
  /** Count of AI-generated messages already in this thread today. */
  currentTurn: number;
  /** Sends made by this org's AI responder in the last 24h. */
  orgSendsToday: number;
  /** Is the current moment inside the property's 08:00–21:00 window? */
  withinBusinessHours: boolean;
};

export function classifyAiSkip(input: SkipInput): SkipDecision {
  if (!input.config) return { skip: true, reason: "no_config" };
  if (!input.config.active) return { skip: true, reason: "disabled_org_wide" };

  if (input.consentState !== "can_send_marketing") {
    return { skip: true, reason: "no_consent" };
  }

  if (input.propertyDisabled) {
    return { skip: true, reason: "disabled_per_property" };
  }

  if (input.orgSendsToday >= input.config.daily_send_cap) {
    return { skip: true, reason: "daily_cap" };
  }

  if (input.currentTurn >= input.config.max_turns) {
    return { skip: true, reason: "max_turns_reached" };
  }

  if (input.config.business_hours_only && !input.withinBusinessHours) {
    return { skip: true, reason: "outside_business_hours" };
  }

  return { skip: false };
}
