import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DialpadVoiceDatabase } from "./database.generated";

/** Call only after session RLS authorizes the parent. Completeness is supplied
 * by the shared SQL manifest gate, not inferred from available-job counts. */
export async function resolveDialpadRecordingStatus(
  client: SupabaseClient<DialpadVoiceDatabase>, orgId: string, callId: string, complete: boolean,
): Promise<"available" | "failed" | "pending"> {
  if (complete) return "available";
  // Every known segment participates in the completeness contract. Check only
  // terminal failure metadata, avoiding row limits hiding a failed segment.
  const { data, error } = await client.from("dialpad_recording_artifacts").select("status")
    .eq("org_id", orgId).eq("provider_call_id", callId).in("status", ["denied", "failed"])
    .limit(1).maybeSingle();
  if (error) throw new Error("Recording processing status unavailable");
  return data?.status === "denied" || data?.status === "failed" ? "failed" : "pending";
}
