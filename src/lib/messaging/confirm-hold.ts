import {
  HOSTILE_NEEDS_CONFIRM_REASON,
  OPTOUT_PHRASE_NEEDS_CONFIRM_REASON,
} from "@/lib/ai-responder/hostile";

/**
 * Jarrad's decision (2026-11-08): campaign and drip/sequence texts must not
 * go to a property whose seller said a "stop texting me"-type phrase or was
 * hostile, while that hold is still open (a person has not cleared it yet).
 * The hold is set by `flagConfirmDncHold` / the hostile escalation:
 * `needs_human_attention = true` and `last_ai_escalation_reason` starting
 * with one of the two reason constants. A person clearing the hold sets
 * `needs_human_attention = false`, which lifts this block. Manual sends from
 * the inbox are never blocked by this check.
 */
export const CONFIRM_HOLD_BLOCK_REASON =
  "Held: the seller has an open stop-texting or hostile hold that a person has not cleared yet.";

export function hasOpenConfirmHold(property: {
  needs_human_attention?: boolean | null;
  last_ai_escalation_reason?: string | null;
} | null | undefined): boolean {
  if (!property || property.needs_human_attention !== true) return false;
  const reason = property.last_ai_escalation_reason ?? "";
  return (
    reason.startsWith(OPTOUT_PHRASE_NEEDS_CONFIRM_REASON) ||
    reason.startsWith(HOSTILE_NEEDS_CONFIRM_REASON)
  );
}
