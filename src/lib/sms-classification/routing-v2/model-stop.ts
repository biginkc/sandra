import { HAIKU_ERROR_ALERT, HAIKU_STOP_ALERT, type FinalDecision } from "./haiku-policy";
import type { V2Decision } from "./route";

/**
 * Routing v2 PR-I: automatic stop suppression (pure decision; Jarrad 2026-10-30).
 *
 * Behind `routing_v2_flags.model_stop_suppression` only (default false).
 * - Suppress (source `model_stop`, never a carrier STOP or DNC source) ONLY when Jev decided
 *   the stop itself: ORDER-TABLE row 1 (legal / hostile) or row 2 (asked to stop) at ≥0.70,
 *   which is final and never goes to Haiku.
 * - Never suppressed, hold + alert instead:
 *   - a Haiku-decided stop → "Possible stop request — please check";
 *   - a Jev stop at 0.60–0.70 that Haiku is unsure about (or that Haiku was never asked
 *     about) → "Possible stop request — please check";
 *   - a Haiku error → "Haiku error — please check".
 * - Flag off = today's human-review path exactly (`human_review`): the opt-out deferral in
 *   ai-responder/dispatch.ts and the thresholds.ts refusal stay in force.
 * Alert labels are reused from haiku-policy.ts verbatim; never reworded here.
 */
export const MODEL_STOP_SOURCE = "model_stop";
export const MODEL_STOP_MIN_PROBABILITY = 0.7;

/** ORDER-TABLE rows 1–2 (route.ts step ids). */
const STOP_STEPS: ReadonlySet<string> = new Set(["legal_hostile", "asked_stop"]);

export type V2StopAction =
  /** The decision is not a stop: the road's own action applies. */
  | { kind: "not_stop" }
  /** Flag off: today's human-review path, unchanged. */
  | { kind: "human_review" }
  /** Write a `model_stop` suppression for the phone. */
  | { kind: "suppress"; step: "legal_hostile" | "asked_stop"; signal: string; probability: number }
  /** Hold for a person and alert Jarrad with this label; nothing is suppressed or sent. */
  | { kind: "hold_alert"; alert: typeof HAIKU_STOP_ALERT | typeof HAIKU_ERROR_ALERT; by: FinalDecision["by"] | "jev" };

export function isStopDecision(d: V2Decision, final: FinalDecision | null): boolean {
  if (final) {
    if (final.road === "stop") return true;
    // A Haiku error on a reply Jev called a stop stays a stop question for a person.
    return final.by === "haiku_failed" && d.road === "stop";
  }
  return d.road === "stop";
}

/**
 * `final` is applyHaikuPolicy's result, or null when the Haiku policy did not run
 * (e.g. the `haiku` flag is off). A Haiku-eligible stop without a Haiku answer is never
 * suppressed.
 */
export function decideV2StopAction(input: {
  decision: V2Decision;
  final: FinalDecision | null;
  modelStopSuppression: boolean;
}): V2StopAction {
  const { decision: d, final } = input;
  if (!isStopDecision(d, final)) return { kind: "not_stop" };
  if (input.modelStopSuppression !== true) return { kind: "human_review" };

  if (final?.by === "haiku_failed") return { kind: "hold_alert", alert: HAIKU_ERROR_ALERT, by: "haiku_failed" };
  if (final?.by === "haiku" || final?.by === "haiku_unsure") return { kind: "hold_alert", alert: HAIKU_STOP_ALERT, by: final.by };

  const p = d.provenance;
  const jevFinal =
    d.road === "stop" &&
    d.haiku === null &&
    (final === null || (final.by === "jev" && final.road === "stop" && !final.hold)) &&
    p.by === "jev" &&
    p.step !== null &&
    STOP_STEPS.has(p.step) &&
    typeof p.probability === "number" &&
    p.probability >= MODEL_STOP_MIN_PROBABILITY;
  if (jevFinal && p.by === "jev" && p.step !== null && p.signal !== null && p.probability !== null) {
    return { kind: "suppress", step: p.step as "legal_hostile" | "asked_stop", signal: p.signal, probability: p.probability };
  }
  // Jev stop at 0.60–0.70 with Haiku unsure, or never asked: hold + alert.
  return { kind: "hold_alert", alert: HAIKU_STOP_ALERT, by: final?.by ?? "jev" };
}
