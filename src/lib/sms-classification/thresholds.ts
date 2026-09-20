import type { JevOutcome } from "./types";

/**
 * Outcomes an org can configure a native-confidence cutoff for. Deliberately
 * excludes `dnc`, `unclear`, and `bad_number` — those are never
 * threshold-gated; see `resolveThresholdDecision` below. Mirrors the
 * `outcome` check constraint on `jev_outcome_thresholds`
 * (20260920225859_jev_outcome_thresholds.sql).
 */
export type ThresholdableOutcome =
  | "new_lead"
  | "wrong_number"
  | "not_interested"
  | "nurture"
  | "opted_out";

export const THRESHOLDABLE_OUTCOMES: ReadonlySet<ThresholdableOutcome> = new Set([
  "new_lead",
  "wrong_number",
  "not_interested",
  "nurture",
  "opted_out",
]);

export function isThresholdableOutcome(
  outcome: JevOutcome,
): outcome is ThresholdableOutcome {
  return THRESHOLDABLE_OUTCOMES.has(outcome as ThresholdableOutcome);
}

/** Per-org, per-outcome cutoffs as loaded from `jev_outcome_thresholds`. */
export type ThresholdMap = Partial<Record<ThresholdableOutcome, number>>;

export type ThresholdDecision =
  | {
      status: "auto_apply";
      outcome: ThresholdableOutcome;
      confidence: number;
      minConfidence: number;
    }
  | {
      status: "needs_decision";
      outcome: ThresholdableOutcome;
      confidence: number;
      minConfidence: number;
    }
  | {
      status: "human_gated";
      reason:
        | "dnc"
        | "not_applicable"
        | "missing_confidence"
        | "invalid_confidence"
        | "no_threshold_configured";
      outcome: JevOutcome;
    };

/**
 * Pure policy function: given a validated outcome + its native confidence,
 * and the org's live threshold map, decide whether the outcome should
 * auto-apply, go to the Needs-a-decision queue, or is human-gated
 * regardless of confidence.
 *
 * Deliberately takes no DB/network dependency so every boundary (exact
 * threshold, missing/invalid score, dnc/unclear always-gated) is testable
 * without mocking Supabase.
 */
export function resolveThresholdDecision(
  decision: { outcome: JevOutcome; outcomeConfidence?: number | null },
  thresholds: ThresholdMap,
): ThresholdDecision {
  if (decision.outcome === "dnc") {
    return { status: "human_gated", reason: "dnc", outcome: decision.outcome };
  }
  if (decision.outcome === "unclear" || decision.outcome === "bad_number") {
    // Neither is a disposition outcome at all — policy.ts already routes
    // both to `no_action` with no effect. Naming this distinctly from
    // `dnc` keeps the audit trail honest about *why* nothing applied.
    return {
      status: "human_gated",
      reason: "not_applicable",
      outcome: decision.outcome,
    };
  }

  const outcome = decision.outcome; // narrowed to ThresholdableOutcome below
  if (!isThresholdableOutcome(outcome)) {
    // Defensive: every JevOutcome is handled by one of the branches above
    // or is threshold-able. If this throws, JevOutcome and this function
    // have drifted out of sync — a code bug, not a runtime data problem.
    throw new Error(`Unhandled JevOutcome in resolveThresholdDecision: ${outcome}`);
  }

  const confidence = decision.outcomeConfidence;
  if (confidence === null || confidence === undefined) {
    return { status: "human_gated", reason: "missing_confidence", outcome };
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { status: "human_gated", reason: "invalid_confidence", outcome };
  }

  const minConfidence = thresholds[outcome];
  if (minConfidence === undefined || minConfidence === null) {
    // No configured cutoff for this org/outcome. Never default to 0 (which
    // would auto-apply everything) or 1 (which would silently block
    // everything) — surface this as its own human-gated reason instead.
    return { status: "human_gated", reason: "no_threshold_configured", outcome };
  }

  return confidence >= minConfidence
    ? { status: "auto_apply", outcome, confidence, minConfidence }
    : { status: "needs_decision", outcome, confidence, minConfidence };
}
