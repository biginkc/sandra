import type { AiStructuredOutput } from "../ai-responder/types";
import { resolveResponderOutcome, type ResponderRoute } from "../ai-responder/route";
import { JEV_OUTCOME_TO_ACTION, type SmsClassificationDecision } from "./types";

/** Maps classification to effects. New leads require human follow-up until
 * a promotion threshold is validated; they must never become nurture closes. */
export type ResolvedPolicyOutcome =
  | { kind: "route"; route: ResponderRoute; assembled: AiStructuredOutput }
  | { kind: "nurture" }
  | { kind: "no_action" };

type ReachableAction = Extract<
  AiStructuredOutput["action"],
  "close_not_interested" | "close_wrong_number" | "opt_out" | "close_dnc"
>;

/**
 * @param decision Validated classification decision (Jev or legacy,
 *   normalized to the same shape).
 */
export async function resolvePolicyOutcome(
  decision: SmsClassificationDecision,
): Promise<ResolvedPolicyOutcome> {
  if (decision.outcome === "new_lead") {
    const assembled: AiStructuredOutput = {
      action: "escalate",
      confidence: confidenceFromDecision(decision),
      sentiment: "positive",
      escalation_reason: decision.escalationReason === "call_request"
        ? "call_request" : "hot_lead",
    };
    return { kind: "route", assembled, route: resolveResponderOutcome(assembled) };
  }

  if (decision.outcome === "bad_number" || decision.outcome === "unclear") {
    // Neither is classifiable from SMS text alone (bad_number needs
    // delivery/bounce evidence; unclear is a genuine no-signal fallback).
    // No route, no nurture — caller decides what "no decision" means
    // (e.g. leave the existing legacy/escalation path untouched).
    return { kind: "no_action" };
  }

  if (decision.outcome === "nurture") {
    return { kind: "nurture" };
  }

  const action = JEV_OUTCOME_TO_ACTION[decision.outcome] as ReachableAction | undefined;
  if (!action) {
    // Defensive: every outcome except bad_number/unclear/nurture must have
    // a mapping. If this throws, JEV_OUTCOME_TO_ACTION and JevOutcome have
    // drifted out of sync — a code bug, not a runtime data problem.
    throw new Error(`No AiAction mapping for Jev outcome: ${decision.outcome}`);
  }

  const sentiment = "neutral" as const; // Jev doesn't classify sentiment; informational only downstream.
  const confidence = confidenceFromDecision(decision);

  let assembled: AiStructuredOutput;
  switch (action) {
    case "close_not_interested":
      assembled = { action, confidence, sentiment };
      break;
    case "opt_out":
      assembled = { action, confidence, sentiment };
      break;
    case "close_dnc":
      assembled = { action, confidence, sentiment };
      break;
    case "close_wrong_number": {
      const scope =
        decision.wrongScope === "this_property" || decision.wrongScope === "all"
          ? decision.wrongScope
          : "this_property"; // route.ts default when scope is ambiguous/uncertain.
      assembled = { action, confidence, sentiment, wrong_scope: scope };
      break;
    }
    default: {
      const _exhaustive: never = action;
      throw new Error(`Unhandled AiAction: ${String(_exhaustive)}`);
    }
  }

  return { kind: "route", route: resolveResponderOutcome(assembled), assembled };
}

/** Never substitute winning probability for native confidence. */
function confidenceFromDecision(decision: SmsClassificationDecision): number {
  const value = decision.outcomeConfidence;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value : 0;
}
