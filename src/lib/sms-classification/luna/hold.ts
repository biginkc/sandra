import type { ClassificationBridgeResult } from "../dispatch-bridge";
import type { JevOutcome } from "../types";

/**
 * The Jev outcome behind a below-threshold HOLD, or null when this
 * classification is not a hold Luna should be asked about (auto-applied,
 * promoted, legacy, failed, no_action). opt_out / close_dnc routes return null
 * on purpose: Luna is never asked about Jev's own opted_out/dnc calls.
 */
export function jevOutcomeForLunaHold(c: ClassificationBridgeResult): JevOutcome | null {
  if (c.kind === "jev_needs_decision") return c.outcome;
  if (c.kind !== "jev_route" || c.eligibleForAutoAccept) return null;
  switch (c.assembled.action) {
    case "close_not_interested":
      return "not_interested";
    case "close_wrong_number":
      return "wrong_number";
    case "escalate":
      return "new_lead";
    default:
      return null;
  }
}
