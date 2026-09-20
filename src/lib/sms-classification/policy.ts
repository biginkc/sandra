import type { AiStructuredOutput } from "../ai-responder/types";
import { resolveResponderOutcome, type ResponderRoute } from "../ai-responder/route";
import { JEV_OUTCOME_TO_ACTION, type SmsClassificationDecision } from "./types";

/**
 * Resolves a validated `SmsClassificationDecision` (from any provider — Jev
 * or legacy) into a `ResponderRoute`, or a `nurture` effect outside the
 * `AiAction` vocabulary.
 *
 * Jev's approved 7-way taxonomy (`JevOutcome`) only ever maps to 4 of the 7
 * `AiAction`s via `JEV_OUTCOME_TO_ACTION`: `close_not_interested`,
 * `close_wrong_number`, `opt_out`, `close_dnc`. None of Jev's outcomes reach
 * `send_reply`, `escalate`, or `deescalate_close` today — this function
 * intentionally does NOT implement those branches. If Jev's taxonomy is ever
 * extended to cover them, the implementer must apply the Fable-reviewed,
 * binding order from 2026-09-20: decide the action first, generate `body`
 * ONLY when the decided action is `send_reply`, assemble the full
 * `AiStructuredOutput`, THEN call `resolveResponderOutcome` — never call it
 * with a fabricated `send_reply` body (`AiStructuredOutput`'s `send_reply`
 * variant requires a real, non-optional `body: string`,
 * `ai-responder/types.ts:71-76`, and Jev never produces one).
 */

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
  const confidence = confidenceFromProbabilities(decision);

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

/**
 * Jev's Choice response gives per-answer probabilities, not a single
 * confidence scalar the way Claude's tool-use does. Use the winning
 * outcome's own probability as the confidence proxy; fall back to 1 when
 * the provider omitted distributions (tolerated per the gateway's contract
 * tests — missing probabilities isn't a hard failure).
 */
function confidenceFromProbabilities(decision: SmsClassificationDecision): number {
  const dist = decision.probabilities.outcome;
  if (!dist) return 1;
  const p = dist[decision.outcome];
  return typeof p === "number" && p >= 0 && p <= 1 ? p : 1;
}
