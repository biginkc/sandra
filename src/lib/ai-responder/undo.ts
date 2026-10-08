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
export type UndoSnapshot = {
  outreachDispo: string | null;
  followUpAt: string | null;
};

export type JevUndoAction = "wrong_number" | "not_interested" | "nurture";

export async function captureUndoSnapshot(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<UndoSnapshot | null> {
  const { data, error } = await supabase
    .from("properties")
    .select("outreach_dispo, follow_up_at")
    .eq("id", propertyId)
    .maybeSingle();
  if (error || !data) {
    reportError(new Error(error?.message ?? "property not found"), {
      tags: { surface: "jev_undo_capture" },
      extra: { propertyId },
    });
    return null;
  }
  return {
    outreachDispo: data.outreach_dispo ?? null,
    followUpAt: data.follow_up_at ?? null,
  };
}

/** Best effort and idempotent per inbound message: never fails the action it describes. */
export async function recordJevActionUndo(
  supabase: SupabaseClient<Database>,
  args: {
    orgId: string;
    propertyId: string;
    inboundMessageId: string | null | undefined;
    classificationRunId: string | null | undefined;
    action: JevUndoAction;
    appliedDispo: string;
    snapshot: UndoSnapshot | null;
    pausedEnrollmentIds?: string[];
  },
): Promise<void> {
  if (!args.inboundMessageId || !args.snapshot) return;
  const { error } = await supabase.from("jev_action_undo").insert({
    org_id: args.orgId,
    property_id: args.propertyId,
    source_inbound_message_id: args.inboundMessageId,
    classification_run_id: args.classificationRunId ?? null,
    action: args.action,
    applied_dispo: args.appliedDispo,
    prior_outreach_dispo: args.snapshot.outreachDispo,
    prior_follow_up_at: args.snapshot.followUpAt,
    paused_enrollment_ids: args.pausedEnrollmentIds ?? [],
  });
  // 23505 = already recorded for this inbound (retry): that is fine.
  if (error && (error as { code?: string }).code !== "23505") {
    reportError(new Error(error.message), {
      tags: { surface: "jev_undo_record" },
      extra: { propertyId: args.propertyId, action: args.action },
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
