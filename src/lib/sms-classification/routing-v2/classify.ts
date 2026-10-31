import { askJev, type JevAskRequest, type JevAskResult, type JevAttemptOutcome } from "../providers/jev-gateway";
import { actionForHaikuOutcome, actionForV2Decision, type V2Action } from "./actions";
import type { ValueLookupResult } from "./dealmachine-value";
import { isV2Eligible, v2SliceAllowed, type RoutingV2Flags } from "./flags";
import { askHaiku, formatHaikuThread, type HaikuAnswer, type HaikuFailure, type HaikuCallResult, type HaikuThreadMessage } from "./haiku";
import { applyHaikuPolicy, type FinalDecision } from "./haiku-policy";
import { decideRepairsFollowUp, isAfterRepairsReply, readRepairsFollowUps, runV2PriceCheck } from "./price-check";
import { NUMBER_SOURCE_QUESTION_ID } from "../questions";
import { buildV2JevRequest, type PropertyTypeOption, type V2QuestionId } from "./questions";
import { assertCompleteV2, routeV2, type V2Decision } from "./route";

/** Decision preparation only. The caller persists this result before executing any effect.
 * A disabled/ineligible caller does not query either provider or change legacy routing.
 * The original Jev decision is retained separately from the final road: suppression must
 * never mistake a Haiku answer for a confident Jev answer.
 */
export type V2Classification =
  | { kind: "off" }
  | {
      kind: "failed";
      reason: "jev_failed" | "jev_incomplete";
      /** Every Jev HTTP attempt actually made (spend ledger); undefined = not reported. */
      jevAttempts?: readonly JevAttemptOutcome[];
      /** Jev's token usage when it answered but incompletely (spend ledger). */
      jevUsage?: { input_tokens?: number; output_tokens?: number } | null;
    }
  | {
      kind: "decided";
      decision: V2Decision;
      final: FinalDecision | null;
      action: V2Action;
      probabilities: Record<V2QuestionId, number>;
      propertyType: Record<PropertyTypeOption, number>;
      haiku: HaikuCallResult | HaikuAnswer | HaikuFailure | null;
      model: string | null;
      latencyMs: number;
      priceOutcome: string | null;
      /** Jev's reported token usage for the spend ledger (A-6); null when not reported. */
      jevUsage?: { input_tokens?: number; output_tokens?: number } | null;
      /** Every Jev HTTP attempt actually made (spend ledger); undefined = not reported. */
      jevAttempts?: readonly JevAttemptOutcome[];
    };

export type V2ClassificationInput = {
  flags: RoutingV2Flags;
  propertyId: string;
  reply: string;
  /** Previous messages, chronological, excluding the current inbound. */
  thread: readonly HaikuThreadMessage[];
  askedHowNumber?: boolean;
  /**
   * Live cutover: ask the existing number-source question in the same Jev call and use its
   * answer ("yes" = asked) when askedHowNumber is not given.
   */
  numberSourceQuestion?: boolean;
};
/** A Jev answer (or failure) that reports the HTTP attempts it took. */
export type JevAskResultWithAttempts = JevAskResult & { attempts?: readonly JevAttemptOutcome[] };
export class JevAttemptsError extends Error {
  constructor(readonly cause: unknown, readonly attempts: readonly JevAttemptOutcome[]) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "JevAttemptsError";
  }
}
export type V2ClassificationDeps = {
  jev: (request: JevAskRequest) => Promise<JevAskResultWithAttempts>;
  haiku: (thread: string[]) => Promise<HaikuCallResult | HaikuAnswer | HaikuFailure>;
  lookupValue: () => Promise<ValueLookupResult>;
};

export function v2ProviderDeps(deps: {
  jev: Parameters<typeof askJev>[1];
  haiku: Parameters<typeof askHaiku>[1];
  lookupValue: V2ClassificationDeps["lookupValue"];
}): V2ClassificationDeps {
  return {
    jev: async (request) => {
      const attempts: JevAttemptOutcome[] = [];
      try {
        const res = await askJev(request, { ...deps.jev, onAttempt: (o) => { attempts.push(o); deps.jev.onAttempt?.(o); } });
        return { ...res, attempts };
      } catch (e) {
        throw new JevAttemptsError(e, attempts);
      }
    },
    haiku: (thread) => askHaiku(thread, deps.haiku),
    lookupValue: deps.lookupValue,
  };
}

export async function classifyV2(input: V2ClassificationInput, deps: V2ClassificationDeps): Promise<V2Classification> {
  const { flags, propertyId } = input;
  if (!flags.questions_live || !isV2Eligible(flags, propertyId)) return { kind: "off" };
  const lastOutbound = [...input.thread].reverse().find((m) => m.direction === "outbound");
  const repairs = v2SliceAllowed(flags, "price_check", propertyId) && isAfterRepairsReply(lastOutbound?.body);
  let raw: JevAskResultWithAttempts;
  try {
    raw = await deps.jev(buildV2JevRequest({
      our_last_text_to_homeowner: lastOutbound?.body ?? null,
      homeowner_reply: input.reply,
    }, { repairsFollowUps: repairs, numberSource: input.numberSourceQuestion === true }));
  } catch (e) {
    return { kind: "failed", reason: "jev_failed", ...(e instanceof JevAttemptsError ? { jevAttempts: e.attempts } : {}) };
  }
  const jevAttempts = raw.attempts ? { jevAttempts: raw.attempts } : {};
  const complete = assertCompleteV2(raw.answers ?? {});
  if (!complete.ok) return { kind: "failed", reason: "jev_incomplete", ...jevAttempts, jevUsage: raw.usage ?? null };
  const decision = routeV2({ reply: input.reply, ...complete });
  let haiku: HaikuCallResult | HaikuAnswer | HaikuFailure | null = null;
  let final: FinalDecision | null = null;
  if (v2SliceAllowed(flags, "haiku", propertyId)) {
    if (decision.haiku !== null) {
      try {
        haiku = await deps.haiku(formatHaikuThread([...input.thread, { direction: "inbound", body: input.reply }]));
      } catch {
        haiku = { ok: false, reason: "haiku_transport" };
      }
    }
    final = applyHaikuPolicy(decision, haiku, complete.probabilities);
  }
  // Preserve the original provenance for the stop/wrong-number adapters. Only the action
  // road changes here. A Haiku-decided offer must not borrow Jev's asked-offer wording.
  const effective: V2Decision = {
    ...decision,
    road: final && final.road !== "ALERT_haiku_unsure" ? final.road : decision.road,
    ...(final?.by === "haiku" ? { provenance: { by: "jev" as const, row: null, step: null, signal: null, probability: null } } : {}),
  };
  let action: V2Action;
  if (final?.by === "haiku_failed") action = actionForHaikuOutcome("error");
  else if (final?.hold) action = actionForHaikuOutcome("haiku_decided_stop");
  else if (final?.road === "ALERT_haiku_unsure") action = actionForHaikuOutcome("unsure_no_jev");
  // With Haiku disabled, an ambiguous stop still needs a person, never silent suppression.
  else if (!final && decision.road === "stop" && decision.haiku !== null) action = actionForHaikuOutcome("haiku_decided_stop");
  else action = actionForV2Decision(effective);

  let priceOutcome: string | null = null;
  // Never let a price follow-up override a failed second opinion or a stop (A-8): a Haiku error,
  // a Haiku-decided / possible stop, or an ambiguous stop with Haiku off. "Jev had no main road
  // and Haiku is unsure" is not one of those: the follow-up answer in the same Jev response
  // decides (decideRepairsFollowUp keeps its own precedence set); if it returns nothing the
  // hold action stands.
  const held = final?.by === "haiku_failed" || final?.hold === true
    || (!final && decision.road === "stop" && decision.haiku !== null);
  if (!held) {
    const followUp = repairs ? decideRepairsFollowUp({
      flags, propertyId, mainDecision: effective,
      followUps: readRepairsFollowUps(raw.answers ?? {}),
      listedProbability: complete.probabilities.listed,
    }) : null;
    if (followUp) {
      action = followUp.action;
      priceOutcome = followUp.outcome;
    } else if (effective.road === "price_check") {
      const price = await runV2PriceCheck({
        flags, propertyId, decision: effective, reply: input.reply,
        propertyType: complete.propertyType, lookupValue: deps.lookupValue,
      });
      action = price.action;
      priceOutcome = price.outcome;
    }
  }
  // The approved number-source reply replaces an existing reply, never adds a second one.
  const askedHowNumber = input.askedHowNumber
    ?? (input.numberSourceQuestion === true && raw.answers?.[NUMBER_SOURCE_QUESTION_ID]?.choice === "yes");
  if (askedHowNumber) action = {
    ...action,
    steps: action.steps.map((step) => step.kind === "reply" ? { kind: "reply", key: "number_source" } : step),
  };
  return {
    kind: "decided", decision, final, action,
    probabilities: complete.probabilities, propertyType: complete.propertyType,
    haiku, model: raw.model ?? null, latencyMs: raw.latencyMs, priceOutcome, jevUsage: raw.usage ?? null,
    ...jevAttempts,
  };
}
