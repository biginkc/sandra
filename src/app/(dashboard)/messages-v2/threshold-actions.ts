"use server";

import { revalidatePath } from "next/cache";

import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { THRESHOLDABLE_OUTCOMES, type ThresholdableOutcome } from "@/lib/sms-classification/thresholds";
import { createClient } from "@/lib/supabase/server";

import { isNeverAuto, NEVER_AUTO_NOTE } from "./rule-policy";

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
  if (input.automationEnabled && isNeverAuto(input.outcome)) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: `${input.outcome} cannot be automated. ${NEVER_AUTO_NOTE}.` },
    };
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

export type NurtureDripMap = {
  maybeLater: string | null;
  checkIn60: string | null;
  listedNotSelling: string | null;
  hotBookAppointment: string | null;
};

export type SetNurtureAutoDripInput = {
  configId: string;
  enabled: boolean;
  /** The drip the owner mapped to each nurture route; all three required to turn on. */
  drips: NurtureDripMap;
};

/**
 * Owner-only switch: Jev's auto-applied `nurture` also enrols the lead in the
 * drip the owner mapped to that lead's route. Takes exactly what the owner
 * confirmed; the real authorization boundary is `fn_set_nurture_auto_drip`
 * (active org owner).
 */
export async function setNurtureAutoDrip(
  input: SetNurtureAutoDripInput,
): Promise<Result<{ enabled: boolean; drips: NurtureDripMap }>> {
  if (typeof input.enabled !== "boolean" || !input.configId || !input.drips) {
    return { ok: false, error: { code: "VALIDATION", message: "Missing switch value." } };
  }
  const { maybeLater, checkIn60, listedNotSelling, hotBookAppointment } = input.drips;
  if (input.enabled && !(maybeLater && checkIn60 && listedNotSelling && hotBookAppointment)) {
    return { ok: false, error: { code: "VALIDATION", message: "Choose all four drips before turning this on." } };
  }
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("fn_set_nurture_auto_drip", {
      p_config_id: input.configId,
      p_enabled: input.enabled,
      p_maybe_later_sequence_id: maybeLater as string,
      p_check_in_60_sequence_id: checkIn60 as string,
      p_listed_not_selling_sequence_id: listedNotSelling as string,
      p_hot_book_appointment_sequence_id: hotBookAppointment as string,
    });
    if (error) {
      const message = error.message.includes("FORBIDDEN")
        ? "Only an org owner can change this."
        : error.message.includes("DRIP_UNAVAILABLE")
          ? "One of those drips is not active. Choose another."
          : error.message;
      return { ok: false, error: { code: "NURTURE_AUTO_DRIP_UPDATE_FAILED", message } };
    }
    const result = data as {
      nurtureAutoDrip: boolean;
      maybeLaterSequenceId: string | null;
      checkIn60SequenceId: string | null;
      listedNotSellingSequenceId: string | null;
      hotBookAppointmentSequenceId: string | null;
    } | null;
    if (!result) {
      return { ok: false, error: { code: "NURTURE_AUTO_DRIP_UPDATE_FAILED", message: "Unexpected empty response" } };
    }
    revalidatePath("/messages-v2");
    return ok({
      enabled: result.nurtureAutoDrip,
      drips: {
        maybeLater: result.maybeLaterSequenceId,
        checkIn60: result.checkIn60SequenceId,
        listedNotSelling: result.listedNotSellingSequenceId,
        hotBookAppointment: result.hotBookAppointmentSequenceId,
      },
    });
  } catch (e) {
    reportError(e, { tags: { surface: "set_nurture_auto_drip" } });
    return errFromUnknown(e, "NURTURE_AUTO_DRIP_UPDATE_FAILED");
  }
}

export type AiRuleSwitch = "nine_identity_reply" | "nine_confirmed_owner_drip" | "classifier_engine";

export type AiRuleSwitchState = {
  configId: string;
  nineIdentityReply: boolean;
  nineConfirmedOwnerDrip: boolean;
  classifierEngine: "outcome_v1" | "nine_questions";
};

const SWITCH_VALUES: Record<AiRuleSwitch, ReadonlySet<string>> = {
  nine_identity_reply: new Set(["true", "false"]),
  nine_confirmed_owner_drip: new Set(["true", "false"]),
  classifier_engine: new Set(["outcome_v1", "nine_questions"]),
};

/**
 * Owner-only rules-panel switches (PR 4). The real authorization boundary is
 * `fn_set_ai_rule_switch` (active org owner, org from the config row); every change
 * is logged with who/when in ai_rule_switch_events by the table trigger.
 */
export async function setAiRuleSwitch(input: {
  configId: string;
  switch: AiRuleSwitch;
  value: string;
}): Promise<Result<AiRuleSwitchState>> {
  const allowed = SWITCH_VALUES[input.switch as AiRuleSwitch];
  if (!input.configId || !allowed || !allowed.has(input.value)) {
    return { ok: false, error: { code: "VALIDATION", message: "Missing switch value." } };
  }
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("fn_set_ai_rule_switch", {
      p_config_id: input.configId,
      p_switch: input.switch,
      p_value: input.value,
    });
    if (error) {
      const message = error.message.includes("FORBIDDEN") ? "Only an org owner can change this." : "Could not change this. Nothing was changed.";
      return { ok: false, error: { code: "AI_RULE_SWITCH_UPDATE_FAILED", message } };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    if (
      typeof row.nineIdentityReply !== "boolean" ||
      typeof row.nineConfirmedOwnerDrip !== "boolean" ||
      (row.classifierEngine !== "outcome_v1" && row.classifierEngine !== "nine_questions")
    ) {
      return { ok: false, error: { code: "AI_RULE_SWITCH_UPDATE_FAILED", message: "Could not confirm the change. Refresh and check." } };
    }
    revalidatePath("/messages-v2");
    return ok({
      configId: input.configId,
      nineIdentityReply: row.nineIdentityReply,
      nineConfirmedOwnerDrip: row.nineConfirmedOwnerDrip,
      classifierEngine: row.classifierEngine,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "set_ai_rule_switch" } });
    return errFromUnknown(e, "AI_RULE_SWITCH_UPDATE_FAILED");
  }
}
