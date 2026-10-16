import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

/**
 * Jarrad (2026-10-07): "Jev shouldn't be making any actions that are
 * irreversible." Before Jev auto-applies wrong_number / not_interested /
 * nurture we capture what the action will overwrite; afterwards we record it
 * (with the sequence enrollments Jev's own action paused) so a person can undo
 * it from the Messages v2 live feed (fn_undo_jev_action + resumeJevPausedEnrollments).
 */
/**
 * The undo record (prior disposition / follow_up_at, what Jev applied, and the
 * decision_context_revision) is written INSIDE the apply RPCs
 * (fn_apply_ai_disposition_with_review, fn_auto_apply_jev_lead_decision), in
 * the same transaction and under the property row lock, so a human edit can
 * never be captured as "what Jev applied". Only the sequence enrollments Jev's
 * wrong_number paused are known after that commit; this stores them.
 * Best effort and idempotent; never fails the action it describes.
 */
export async function recordPausedEnrollmentsForUndo(
  supabase: SupabaseClient<Database>,
  args: { inboundMessageId: string | null | undefined; pausedEnrollmentIds: string[] },
): Promise<void> {
  if (!args.inboundMessageId || args.pausedEnrollmentIds.length === 0) return;
  const { error } = await supabase
    .from("jev_action_undo")
    .update({ paused_enrollment_ids: args.pausedEnrollmentIds })
    .eq("source_inbound_message_id", args.inboundMessageId)
    .is("undone_at", null);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "jev_undo_record_paused" },
      extra: { inboundMessageId: args.inboundMessageId },
    });
  }
}

export type UndoJevActionResult =
  | { ok: true; status: "undone" | "already_undone"; resumed: number; resumeFailed: number }
  | { ok: false; code: "STATE_CHANGED" | "NOT_FOUND" | "FORBIDDEN" | "FAILED"; message: string };

/**
 * Restores disposition + follow_up_at atomically (fn_undo_jev_action), then
 * resumes the sequence enrollments Jev's own action paused. The resume step
 * re-validates the pause reason under the enrollment lock, so an enrollment a
 * person has since paused or changed is left alone.
 */
export async function undoJevAction(
  userClient: SupabaseClient<Database>,
  undoId: string,
): Promise<UndoJevActionResult> {
  const { data, error } = await userClient.rpc("fn_undo_jev_action", { p_undo_id: undoId });
  if (error) {
    const m = error.message;
    if (m.includes("STATE_CHANGED")) {
      return {
        ok: false,
        code: "STATE_CHANGED",
        message: "Someone changed this lead after Jev did, so it was not undone.",
      };
    }
    if (m.includes("NOT_FOUND")) return { ok: false, code: "NOT_FOUND", message: "Nothing to undo." };
    if (m.includes("FORBIDDEN") || m.includes("AUTHENTICATION_REQUIRED")) {
      return { ok: false, code: "FORBIDDEN", message: "You cannot undo this." };
    }
    reportError(new Error(m), { tags: { surface: "jev_undo_action" }, extra: { undoId } });
    return { ok: false, code: "FAILED", message: "Could not undo. Try again." };
  }
  const result = data as { status?: string; enrollmentIds?: string[] } | null;
  const status = result?.status === "already_undone" ? "already_undone" : "undone";
  let resumed = 0;
  let resumeFailed = 0;
  for (const enrollmentId of result?.enrollmentIds ?? []) {
    const { data: rows, error: resumeError } = await userClient.rpc("resume_sequence_enrollment", {
      p_enrollment_id: enrollmentId,
      p_expected_pause_reason: "inbound_reply",
    });
    if (resumeError) {
      resumeFailed += 1;
      reportError(new Error(resumeError.message), {
        tags: { surface: "jev_undo_resume_enrollment" },
        extra: { undoId, enrollmentId },
      });
      continue;
    }
    const outcome = (rows as Array<{ outcome?: string }> | null)?.[0]?.outcome;
    if (outcome === "resumed") resumed += 1;
  }
  return { ok: true, status, resumed, resumeFailed };
}
