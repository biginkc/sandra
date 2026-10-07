"use server";

import { revalidatePath } from "next/cache";

import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { THRESHOLDABLE_OUTCOMES, type ThresholdableOutcome } from "@/lib/sms-classification/thresholds";
import { createClient } from "@/lib/supabase/server";

export type SetLabelRuleInput = {
  orgId: string;
  outcome: ThresholdableOutcome;
  minConfidence: number;
  automationEnabled: boolean;
  /** The rule version the owner was looking at; a concurrent edit is a visible conflict. */
  expectedVersion: number;
};

export type SetLabelRuleResult = {
  minConfidence: number;
  automationEnabled: boolean;
  version: number;
};

/**
 * Change one label's rule (cutoff and on/off) from the Messages v2 header.
 * Takes exactly what the owner confirmed on screen; never fills in a value.
 * The real authorization boundary is `fn_set_jev_outcome_threshold` (active
 * org owner only), which also writes the audit row in
 * jev_outcome_threshold_history.
 */
export async function setLabelRule(input: SetLabelRuleInput): Promise<Result<SetLabelRuleResult>> {
  if (!THRESHOLDABLE_OUTCOMES.has(input.outcome)) {
    return { ok: false, error: { code: "VALIDATION", message: `Unsupported outcome: ${input.outcome}` } };
  }
  if (
    !Number.isFinite(input.minConfidence) ||
    input.minConfidence < 0 ||
    input.minConfidence > 1 ||
    Math.round(input.minConfidence * 1000) / 1000 !== input.minConfidence
  ) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Confidence cutoff must be between 0 and 1 with at most three decimals." },
    };
  }
  if (typeof input.automationEnabled !== "boolean") {
    return { ok: false, error: { code: "VALIDATION", message: "Automation must be on or off." } };
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    return { ok: false, error: { code: "VALIDATION", message: "Missing rule version." } };
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("fn_set_jev_outcome_threshold", {
      p_org_id: input.orgId,
      p_outcome: input.outcome,
      p_min_confidence: input.minConfidence,
      p_expected_version: input.expectedVersion,
      p_idempotency_key: crypto.randomUUID(),
      p_automation_enabled: input.automationEnabled,
    });
    if (error) {
      const message = error.message.includes("STALE_STATE")
        ? "Someone else changed this rule. Reload the page and try again."
        : error.message.includes("FORBIDDEN")
          ? "Only an org owner can change these rules."
          : error.message;
      return { ok: false, error: { code: "LABEL_RULE_UPDATE_FAILED", message } };
    }
    const result = data as { minConfidence: number; automationEnabled: boolean; version: number } | null;
    if (!result) {
      return { ok: false, error: { code: "LABEL_RULE_UPDATE_FAILED", message: "Unexpected empty response" } };
    }
    revalidatePath("/messages-v2");
    return ok({
      minConfidence: Number(result.minConfidence),
      automationEnabled: result.automationEnabled,
      version: result.version,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "set_label_rule" } });
    return errFromUnknown(e, "LABEL_RULE_UPDATE_FAILED");
  }
}
