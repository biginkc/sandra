import { matchEscalationKeyword } from "../../ai-responder/keywords";
import { matchesDncKeyword, matchesStopKeyword } from "../../messaging/stop-signals";
import type { JevOutcome } from "../types";

/**
 * Pure gate: should Luna be asked for a suggestion on this below-threshold hold?
 *
 * Luna is only a suggestion for the outcomes a human can pick from a hold.
 * It is never asked when Jev itself said opted_out/dnc (those stay on the
 * human opt-out/legal path untouched), nor when any existing keyword / STOP /
 * do-not-contact signal fired on the inbound text. The signal checks reuse the
 * existing detectors (stop-signals.ts is inbound.ts's own lists, moved
 * verbatim; keywords.ts is the responder's escalation list); no new phrase
 * lists are defined here.
 */
export type LunaSkipReason =
  | "disabled"
  | "jev_opted_out"
  | "jev_dnc"
  | "jev_outcome_not_askable"
  | "stop_signal"
  | "escalation_keyword";

export type LunaEligibility = { ask: true } | { ask: false; reason: LunaSkipReason };

const ASKABLE_JEV_OUTCOMES: ReadonlySet<JevOutcome> = new Set([
  "new_lead",
  "nurture",
  "not_interested",
  "wrong_number",
]);

export function lunaEligibility(args: {
  enabled: boolean;
  jevOutcome: JevOutcome;
  inboundBody: string;
  /** ai_responder_configs.escalation_keywords, exactly as the keyword gate uses it. */
  escalationKeywords?: ReadonlyArray<string> | null;
}): LunaEligibility {
  if (!args.enabled) return { ask: false, reason: "disabled" };
  if (args.jevOutcome === "opted_out") return { ask: false, reason: "jev_opted_out" };
  if (args.jevOutcome === "dnc") return { ask: false, reason: "jev_dnc" };
  if (!ASKABLE_JEV_OUTCOMES.has(args.jevOutcome)) return { ask: false, reason: "jev_outcome_not_askable" };
  if (matchesStopKeyword(args.inboundBody) || matchesDncKeyword(args.inboundBody)) {
    return { ask: false, reason: "stop_signal" };
  }
  if (matchEscalationKeyword(args.inboundBody, { allowedPhrases: args.escalationKeywords ?? undefined })) {
    return { ask: false, reason: "escalation_keyword" };
  }
  return { ask: true };
}
