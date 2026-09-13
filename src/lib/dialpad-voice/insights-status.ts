import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DialpadInsightsDatabase } from "./insights-database.generated";

/** Parent activity must already be authorized through session RLS. Stored
 * results survive a failed refresh; queue failures must not look pending forever. */
export async function resolveDialpadInsightStatus(
  client: SupabaseClient<DialpadInsightsDatabase>, orgId: string, callId: string,
  state: "call_transcription" | "recap_summary", storedStatus: string | null | undefined,
): Promise<string> {
  if (storedStatus === "available" || storedStatus === "none") return storedStatus;
  const { data, error } = await client.from("dialpad_voice_event_inbox").select("status")
    .eq("org_id", orgId).filter("payload->>call_id", "eq", callId)
    .filter("payload->>state", "eq", state).order("received_at", { ascending: false })
    .order("id", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error("Insight processing status unavailable");
  if (data?.status === "failed" || data?.status === "quarantined") return "failed";
  return storedStatus === "failed" && !data ? "failed" : "pending";
}
