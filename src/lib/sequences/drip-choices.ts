import type { SupabaseClient } from "@supabase/supabase-js";

import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { previewFirstSend } from "@/lib/sequences/start-drip";

export type DripChoice = { id: string; name: string; textCount: number; voicemailCount?: number; days: number; firstSend: string | null };

/** Shared by the listDripChoices server action and GET /api/sequences/drip-choices; reads under the caller's RLS scope. */
export async function loadDripChoices(supabase: SupabaseClient): Promise<Result<DripChoice[]>> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };
    const { data: sequences, error } = await supabase.from("sequences")
      .select("id, name, created_by").eq("active", true).is("archived_at", null).order("name");
    if (error) return { ok: false, error: { code: "SEQ_LIST_FAILED", message: error.message } };
    const visibleSequences = ((sequences ?? []) as { id: string; name: string; created_by: string | null }[]).filter((sequence) =>
      !process.env.SEQUENCE_CANARY_USER_ID || sequence.created_by !== process.env.SEQUENCE_CANARY_USER_ID);
    if (!visibleSequences.length) return ok([]);
    const { data: steps, error: stepError } = await supabase.from("sequence_steps")
      .select("sequence_id, step_index, delay_after_previous_minutes, action_type")
      .in("sequence_id", visibleSequences.map((sequence) => sequence.id)).order("step_index");
    if (stepError) return { ok: false, error: { code: "SEQ_LIST_FAILED", message: stepError.message } };
    const rows = (steps ?? []) as { sequence_id: string; step_index: number; delay_after_previous_minutes: number; action_type: string }[];
    return ok(visibleSequences.flatMap((sequence) => {
      const own = rows.filter((step) => step.sequence_id === sequence.id);
      if (!own.length || own[0].step_index !== 0) return [];
      const firstSmsIndex = own.findIndex((step) => step.action_type === "send_sms");
      return [{
        id: sequence.id,
        name: sequence.name,
        textCount: own.filter((step) => step.action_type === "send_sms").length,
        voicemailCount: own.filter((step) => step.action_type === "send_voicemail_drop").length,
        days: Math.ceil(own.reduce((sum, step) => sum + step.delay_after_previous_minutes, 0) / 1440),
        firstSend: firstSmsIndex < 0 ? null : previewFirstSend(
          own.slice(0, firstSmsIndex + 1).reduce((sum, step) => sum + step.delay_after_previous_minutes, 0),
          "America/Chicago",
        ),
      }];
    }));
  } catch (e) {
    reportError(e, { tags: { surface: "list_drip_choices" } });
    return errFromUnknown(e, "SEQ_LIST_FAILED");
  }
}
