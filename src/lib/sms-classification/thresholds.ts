import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../supabase/types";
import type { JevOutcome } from "./types";

/**
 * Outcomes an org can configure a native-confidence cutoff for. Deliberately
 * excludes `dnc`, `unclear`, and `bad_number` — those are never
 * threshold-gated; see `resolveThresholdDecision` below. Mirrors the
 * `outcome` check constraint on `jev_outcome_thresholds`
 * (20261008140000_jev_outcome_thresholds.sql).
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

/**
 * HARD RULE (Jarrad, 2026-10-07, verbatim: "I don't want you making any DNC
 * decisions. I don't want Jev making any DNC decisions."): a model judgment
 * never suppresses a phone or sets an opt-out/DNC disposition on its own.
 * `opted_out` stays a thresholdable outcome (scorecard, history) but is
 * ALWAYS human-gated here, whatever its confidence and whatever
 * `automation_enabled` says. `dnc` is already never thresholdable. The
 * `fn_set_jev_outcome_threshold` RPC refuses to switch automation on for
 * these outcomes too (20261008300000). The only automatic suppression left
 * in the system is the deterministic carrier STOP keyword path in
 * `messaging/inbound.ts`.
 */
export const HUMAN_ONLY_OUTCOMES: ReadonlySet<string> = new Set(["opted_out", "dnc"]);

export function isHumanOnlyOutcome(outcome: string): boolean {
  return HUMAN_ONLY_OUTCOMES.has(outcome);
}

export function isThresholdableOutcome(
  outcome: JevOutcome,
): outcome is ThresholdableOutcome {
  return THRESHOLDABLE_OUTCOMES.has(outcome as ThresholdableOutcome);
}

/** Per-org, per-outcome cutoffs as loaded from `jev_outcome_thresholds` —
 *  carries the settings row's own `version` alongside the numeric cutoff
 *  (root final-review P2, jev-root-final-review.md, 2026-09-20: the
 *  version actually used at decision time must be recorded, not just the
 *  numeric value, since two versions can share the same number). */
export type ThresholdMap = Partial<
  Record<
    ThresholdableOutcome,
    {
      minConfidence: number;
      version: number;
      /** Explicit per-outcome on/off switch (`automation_enabled`). When
       *  false the outcome is ALWAYS human-gated, whatever the confidence
       *  (a confidence of 1.0 would otherwise clear any numeric cutoff).
       *  Seeded to preserve production today: true for not_interested /
       *  wrong_number / nurture / opted_out, false for new_lead (the
       *  origin/main policy escalated every new_lead to a human). */
      automationEnabled: boolean;
    }
  >
>;

export type ThresholdDecision =
  | {
      status: "auto_apply";
      outcome: ThresholdableOutcome;
      confidence: number;
      minConfidence: number;
      thresholdVersion: number;
    }
  | {
      status: "needs_decision";
      outcome: ThresholdableOutcome;
      confidence: number;
      minConfidence: number;
      thresholdVersion: number;
    }
  | {
      status: "human_gated";
      reason:
        | "dnc"
        | "not_applicable"
        | "missing_confidence"
        | "invalid_confidence"
        | "no_threshold_configured"
        | "automation_disabled"
        | "human_only_outcome";
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

  if (decision.outcome === "opted_out") {
    // Hard rule (see HUMAN_ONLY_OUTCOMES): checked before confidence or the
    // automation switch so no config value can ever auto-apply it.
    return { status: "human_gated", reason: "human_only_outcome", outcome: decision.outcome };
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

  const configured = thresholds[outcome];
  if (configured === undefined || configured === null) {
    // No configured cutoff for this org/outcome. Never default to 0 (which
    // would auto-apply everything) or 1 (which would silently block
    // everything) — surface this as its own human-gated reason instead.
    return { status: "human_gated", reason: "no_threshold_configured", outcome };
  }
  const { minConfidence, version: thresholdVersion, automationEnabled } = configured;
  // Explicit switch beats any confidence value, including 1.0.
  if (automationEnabled !== true) {
    return { status: "human_gated", reason: "automation_disabled", outcome };
  }

  return confidence >= minConfidence
    ? { status: "auto_apply", outcome, confidence, minConfidence, thresholdVersion }
    : { status: "needs_decision", outcome, confidence, minConfidence, thresholdVersion };
}

/**
 * Loads the org's live per-outcome thresholds from `jev_outcome_thresholds`
 * (20261008140000_jev_outcome_thresholds.sql). Read live at classification
 * time — no caching — so an edit through `fn_set_jev_outcome_threshold`
 * takes effect on the very next classification with no deployment.
 *
 * A DB error or missing row for an outcome is never silently treated as
 * "no threshold configured means auto-apply" — `resolveThresholdDecision`
 * already treats an absent map entry as `human_gated`, which is the safe
 * default either way.
 */
export async function loadOrgThresholdMap(
  supabase: SupabaseClient<Database>,
  orgId: string,
): Promise<ThresholdMap> {
  const { data, error } = await supabase
    .from("jev_outcome_thresholds")
    .select("outcome, min_confidence, version, automation_enabled")
    .eq("org_id", orgId);
  if (error || !data) return {};

  const map: ThresholdMap = {};
  for (const row of data) {
    if (isThresholdableOutcome(row.outcome as JevOutcome)) {
      map[row.outcome as ThresholdableOutcome] = {
        minConfidence: row.min_confidence,
        version: row.version,
        // Fail closed: anything but an explicit true holds for a human.
        automationEnabled: row.automation_enabled === true,
      };
    }
  }
  return map;
}
