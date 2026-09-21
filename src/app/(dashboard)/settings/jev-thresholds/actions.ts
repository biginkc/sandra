"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { THRESHOLDABLE_OUTCOMES, type ThresholdableOutcome } from "@/lib/sms-classification/thresholds";
import { createClient } from "@/lib/supabase/server";

export type JevThresholdRow = {
  outcome: ThresholdableOutcome;
  minConfidence: number;
  version: number;
};

export type GetJevThresholdsResult = {
  orgId: string;
  rows: JevThresholdRow[];
};

/**
 * Loads the current org's live per-outcome thresholds. A missing row for
 * an outcome (e.g. an org created after the seed backfill, before its
 * first classification) is surfaced as version 0 so the form can still
 * create it via fn_set_jev_outcome_threshold's optimistic-concurrency
 * "0 means create" convention — never silently defaulted to a specific
 * confidence value here.
 */
export async function getJevThresholds(): Promise<Result<GetJevThresholdsResult | null>> {
  try {
    const supabase = await createClient();
    const { data: org } = await supabase
      .from("organizations")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!org) return ok(null);

    const { data, error } = await supabase
      .from("jev_outcome_thresholds")
      .select("outcome, min_confidence, version")
      .eq("org_id", org.id);
    if (error) {
      return { ok: false, error: { code: "JEV_THRESHOLDS_FETCH_FAILED", message: error.message } };
    }

    const byOutcome = new Map(
      (data ?? []).map((row) => [row.outcome, { minConfidence: row.min_confidence, version: row.version }]),
    );
    const rows: JevThresholdRow[] = Array.from(THRESHOLDABLE_OUTCOMES).map((outcome) => {
      const existing = byOutcome.get(outcome);
      return {
        outcome,
        minConfidence: existing?.minConfidence ?? 0,
        version: existing?.version ?? 0,
      };
    });

    return ok({ orgId: org.id, rows });
  } catch (e) {
    reportError(e, { tags: { surface: "get_jev_thresholds" } });
    return errFromUnknown(e, "JEV_THRESHOLDS_FETCH_FAILED");
  }
}

export type SetJevThresholdInput = {
  orgId: string;
  outcome: ThresholdableOutcome;
  minConfidence: number;
  expectedVersion: number;
};

export type SetJevThresholdResult = {
  minConfidence: number;
  version: number;
};

/**
 * Updates one outcome's threshold. Admin-only in the UI (same
 * `isAdminEmail` gate the AI-responder settings page uses) — but the
 * real authorization boundary is `fn_set_jev_outcome_threshold` itself
 * (owner-role, active membership), which cannot be bypassed by calling
 * this action directly. `expectedVersion` implements the same visible
 * stale-conflict UX as other settings forms in this app: a concurrent
 * edit surfaces as a clear "someone else changed this" error, never a
 * silent overwrite.
 */
export async function setJevThreshold(
  input: SetJevThresholdInput,
): Promise<Result<SetJevThresholdResult>> {
  if (!THRESHOLDABLE_OUTCOMES.has(input.outcome)) {
    return { ok: false, error: { code: "VALIDATION", message: `Unsupported outcome: ${input.outcome}` } };
  }
  if (
    !Number.isFinite(input.minConfidence) ||
    input.minConfidence < 0 ||
    input.minConfidence > 1
  ) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Confidence cutoff must be between 0 and 1." },
    };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminEmail(user?.email)) {
      return {
        ok: false,
        error: { code: "FORBIDDEN", message: "Only admins can edit Jev thresholds." },
      };
    }

    const { data, error } = await supabase.rpc("fn_set_jev_outcome_threshold", {
      p_org_id: input.orgId,
      p_outcome: input.outcome,
      p_min_confidence: input.minConfidence,
      p_expected_version: input.expectedVersion,
      p_idempotency_key: randomUUID(),
    });
    if (error) {
      const message = error.message.includes("STALE_STATE")
        ? "Someone else already changed this threshold. Reload and try again."
        : error.message.includes("FORBIDDEN")
          ? "Only an org owner can edit Jev thresholds."
          : error.message;
      return { ok: false, error: { code: "JEV_THRESHOLD_UPDATE_FAILED", message } };
    }

    const result = data as { minConfidence: number; version: number } | null;
    if (!result) {
      return { ok: false, error: { code: "JEV_THRESHOLD_UPDATE_FAILED", message: "Unexpected empty response" } };
    }

    revalidatePath("/settings/jev-thresholds");
    return ok({ minConfidence: result.minConfidence, version: result.version });
  } catch (e) {
    reportError(e, { tags: { surface: "set_jev_threshold" } });
    return errFromUnknown(e, "JEV_THRESHOLD_UPDATE_FAILED");
  }
}
