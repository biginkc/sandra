"use server";

import { revalidatePath } from "next/cache";

import { setOutreachDispo } from "@/app/(dashboard)/messages/dispo-actions";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { qualifyProperty } from "@/lib/leads/qualify";
import { createClient } from "@/lib/supabase/server";

export type JevQueueSource = "ai_disposition_review" | "jev_lead_decision" | "classifier_event";

const FULL_TAXONOMY = ["new_lead", "wrong_number", "not_interested", "nurture", "opted_out", "dnc"] as const;
type FullOutcome = (typeof FULL_TAXONOMY)[number];

/** wrong_number/not_interested/nurture (both sources) and new_lead (
 *  jev_lead_decision only, which already has its own qualify-guard
 *  branch in SQL) write directly via the narrow correction RPCs.
 *  Everything else — new_lead on an ai_disposition_review row, and
 *  opted_out/dnc on either — goes through the sanctioned TS operation
 *  first (qualifyProperty / setOutreachDispo), then a "record" RPC. See
 *  fn_record_*_correction in
 *  20260921003340_jev_review_taxonomy_and_marking.sql for why
 *  suppression can't be re-implemented purely in SQL here. */
const AI_DISPOSITION_DIRECT_SQL_TARGETS = new Set<FullOutcome>(["wrong_number", "not_interested", "nurture"]);
const LEAD_DECISION_DIRECT_SQL_TARGETS = new Set<FullOutcome>([
  "new_lead",
  "wrong_number",
  "not_interested",
  "nurture",
]);

function isFullOutcome(value: string): value is FullOutcome {
  return (FULL_TAXONOMY as readonly string[]).includes(value);
}

/**
 * Confirms a still-pending proposal as-is — no reviewer-name/evidence
 * form, the authenticated actor is inferred by the RPC from auth.uid().
 * For a row that already applied automatically (auto_accepted, or a
 * jev_lead_decision confirmed with no human involved), use
 * markJevQueueItemReviewed instead — confirming a pending row and
 * marking an auto-applied row as reviewed are different operations:
 * the former performs the disposition write, the latter must never
 * re-apply anything that already happened.
 */
export async function confirmJevQueueItem(
  source: JevQueueSource,
  id: string,
): Promise<Result<{ status: string }>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };

    if (source === "ai_disposition_review") {
      const { data, error } = await supabase.rpc("fn_confirm_ai_disposition_review", {
        p_review_id: id,
      });
      if (error) return { ok: false, error: { code: "JEV_CONFIRM_FAILED", message: error.message } };
      const status = (data as { status?: string } | null)?.status;
      if (!status) return { ok: false, error: { code: "JEV_CONFIRM_FAILED", message: "Unexpected response" } };
      revalidatePath("/jev/needs-decision");
      revalidatePath("/jev/review");
      return ok({ status });
    }

    if (source === "jev_lead_decision") {
      const { data, error } = await supabase.rpc("fn_confirm_jev_lead_decision", {
        p_decision_id: id,
      });
      if (error) {
        const message = error.message.includes("DNC_LOCKED")
          ? "This property is permanently locked and cannot be promoted."
          : error.message;
        return { ok: false, error: { code: "JEV_CONFIRM_FAILED", message } };
      }
      const status = (data as { status?: string } | null)?.status;
      if (!status) return { ok: false, error: { code: "JEV_CONFIRM_FAILED", message: "Unexpected response" } };
      revalidatePath("/jev/needs-decision");
      revalidatePath("/jev/review");
      return ok({ status });
    }

    return { ok: false, error: { code: "VALIDATION", message: "classifier_event rows cannot be confirmed." } };
  } catch (e) {
    reportError(e, { tags: { surface: "jev_confirm_queue_item" }, extra: { source, id } });
    return errFromUnknown(e, "JEV_CONFIRM_FAILED");
  }
}

/**
 * Marks an already-applied decision (auto_accepted, or a system-
 * confirmed jev_lead_decision with no human involved) as reviewed —
 * records that a human looked at it, WITHOUT re-running the disposition
 * write or promotion. Idempotent: marking twice keeps the original
 * reviewer/time.
 */
export async function markJevQueueItemReviewed(
  source: JevQueueSource,
  id: string,
): Promise<Result<{ status: string }>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };

    const rpcName =
      source === "ai_disposition_review"
        ? "fn_mark_ai_disposition_review_reviewed"
        : source === "jev_lead_decision"
          ? "fn_mark_jev_lead_decision_reviewed"
          : null;
    if (!rpcName) {
      return { ok: false, error: { code: "VALIDATION", message: "classifier_event rows have nothing to mark reviewed." } };
    }

    const args = source === "ai_disposition_review" ? { p_review_id: id } : { p_decision_id: id };
    const { data, error } = await supabase.rpc(rpcName, args);
    if (error) return { ok: false, error: { code: "JEV_MARK_REVIEWED_FAILED", message: error.message } };
    const status = (data as { status?: string } | null)?.status;
    if (!status) return { ok: false, error: { code: "JEV_MARK_REVIEWED_FAILED", message: "Unexpected response" } };
    revalidatePath("/jev/review");
    return ok({ status });
  } catch (e) {
    reportError(e, { tags: { surface: "jev_mark_queue_item_reviewed" }, extra: { source, id } });
    return errFromUnknown(e, "JEV_MARK_REVIEWED_FAILED");
  }
}

const CORRECTION_ERROR_MESSAGES: Record<string, string> = {
  STALE_STATE: "This lead changed since Jev made this decision. Reload and try again.",
  DNC_LOCKED: "This property is permanently locked and cannot be promoted.",
  INVALID_CORRECTION_TARGET: "That outcome cannot be chosen here.",
};

function friendlyCorrectionError(message: string): string {
  for (const [code, friendly] of Object.entries(CORRECTION_ERROR_MESSAGES)) {
    if (message.includes(code)) return friendly;
  }
  return message;
}

/**
 * Lets a human pick the correct outcome directly, across the full
 * taxonomy — no evidence/reviewer form, reason is optional. Works
 * whether the row is still pending or already resolved, and more than
 * once on the same row. wrong_number/not_interested/nurture (and
 * new_lead for a jev_lead_decision row) write directly via a guarded SQL
 * RPC. new_lead on an ai_disposition_review row, and opted_out/dnc on
 * either source, are applied through the EXISTING sanctioned promotion/
 * suppression operations first (qualifyProperty / setOutreachDispo —
 * same code every other promotion/suppression in the app uses, so the
 * same guards and TCPA side effects apply here), then recorded in the
 * audit trail. Never unsuppresses on a positive correction — the
 * restricted direct-SQL targets never touch consent_events, and the
 * sanctioned operations only ever ADD suppression, never remove it.
 */
export async function correctJevQueueItem(
  source: JevQueueSource,
  id: string,
  propertyId: string,
  correctedOutcome: string,
  reason: string | null,
): Promise<Result<{ status: string; resolvedOutcome: string }>> {
  try {
    if (!isFullOutcome(correctedOutcome)) {
      return { ok: false, error: { code: "VALIDATION", message: `Unsupported outcome: ${correctedOutcome}` } };
    }
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };

    if (source === "classifier_event") {
      return { ok: false, error: { code: "VALIDATION", message: "classifier_event rows cannot be corrected — no decision was made." } };
    }

    const directTargets = source === "ai_disposition_review" ? AI_DISPOSITION_DIRECT_SQL_TARGETS : LEAD_DECISION_DIRECT_SQL_TARGETS;

    if (directTargets.has(correctedOutcome)) {
      const rpcName = source === "ai_disposition_review" ? "fn_correct_ai_disposition_review" : "fn_correct_jev_lead_decision";
      const args =
        source === "ai_disposition_review"
          ? { p_review_id: id, p_corrected_disposition: correctedOutcome, p_reason: reason ?? "" }
          : { p_decision_id: id, p_corrected_outcome: correctedOutcome, p_reason: reason ?? "" };
      const { data, error } = await supabase.rpc(rpcName, args);
      if (error) {
        return { ok: false, error: { code: "JEV_CORRECTION_FAILED", message: friendlyCorrectionError(error.message) } };
      }
      const result = data as { status?: string; correctedDisposition?: string; resolvedOutcome?: string } | null;
      const resolvedOutcome = result?.correctedDisposition ?? result?.resolvedOutcome;
      if (!result?.status || !resolvedOutcome) {
        return { ok: false, error: { code: "JEV_CORRECTION_FAILED", message: "Unexpected response" } };
      }
      revalidatePath("/jev/needs-decision");
      revalidatePath("/jev/review");
      return ok({ status: result.status, resolvedOutcome });
    }

    // new_lead (ai_disposition_review only) / opted_out / dnc: apply via
    // the sanctioned operation first, then record.
    if (correctedOutcome === "new_lead") {
      const qualifyOutcome = await qualifyProperty(supabase, propertyId, user.id);
      if (qualifyOutcome.status === "failed") {
        const message = qualifyOutcome.message.includes("DNC_LOCKED")
          ? "This property is permanently locked and cannot be promoted."
          : qualifyOutcome.message;
        return { ok: false, error: { code: "JEV_CORRECTION_FAILED", message } };
      }
      if (qualifyOutcome.status === "not_found") {
        return { ok: false, error: { code: "JEV_CORRECTION_FAILED", message: "Property not found." } };
      }
      // "qualified" or "already_qualified" (idempotent replay) both mean
      // the property is now (or already was) new_lead — proceed to record.
    } else {
      // opted_out or dnc.
      const dispoResult = await setOutreachDispo(propertyId, correctedOutcome);
      if (!dispoResult.ok) {
        return { ok: false, error: { code: "JEV_CORRECTION_FAILED", message: dispoResult.error } };
      }
    }

    const recordRpcName = source === "ai_disposition_review" ? "fn_record_ai_disposition_review_correction" : "fn_record_jev_lead_decision_correction";
    const recordArgs =
      source === "ai_disposition_review"
        ? { p_review_id: id, p_corrected_disposition: correctedOutcome, p_reason: reason ?? "" }
        : { p_decision_id: id, p_corrected_outcome: correctedOutcome, p_reason: reason ?? "" };
    const { data: recordData, error: recordError } = await supabase.rpc(recordRpcName, recordArgs);
    if (recordError) {
      // The sanctioned operation already succeeded — the property is
      // correctly updated. Only the audit record failed; log it but
      // don't tell the operator the correction itself failed.
      reportError(new Error(recordError.message), {
        tags: { surface: "jev_correction_record_after_sanctioned_op" },
        extra: { source, id, correctedOutcome },
      });
      revalidatePath("/jev/needs-decision");
      revalidatePath("/jev/review");
      return ok({ status: "corrected", resolvedOutcome: correctedOutcome });
    }
    const recordResult = recordData as { status?: string } | null;
    revalidatePath("/jev/needs-decision");
    revalidatePath("/jev/review");
    return ok({ status: recordResult?.status ?? "corrected", resolvedOutcome: correctedOutcome });
  } catch (e) {
    reportError(e, { tags: { surface: "jev_correct_queue_item" }, extra: { source, id, correctedOutcome } });
    return errFromUnknown(e, "JEV_CORRECTION_FAILED");
  }
}
