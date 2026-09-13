import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DialpadVoiceDatabase } from "./database.generated";
import { normalizeDialpadCallEvent } from "./call-event";

/** Receipts in this table were authenticated before insertion. This supplies
 * only a candidate URL; the downloader still enforces its host/path/media rules.
 * Caller first verifies the same recording ID/type in an authenticated Call Get.
 */
export async function signedRecordingUrl(client: SupabaseClient<DialpadVoiceDatabase>, options: {
  orgId: string; callId: string; providerUserId: string; recordingId: string; recordingKind: string;
}): Promise<string | null> {
  const { data, error } = await client.from("dialpad_voice_event_inbox").select("payload")
    .eq("org_id", options.orgId).filter("payload->>call_id", "eq", options.callId)
    .filter("payload->>state", "eq", "recording").order("received_at", { ascending: false }).limit(20);
  if (error) throw new Error("Signed recording source unavailable");
  let newest: { timestamp: number; url: string } | null = null;
  for (const row of data ?? []) {
    try {
      const event = normalizeDialpadCallEvent(row.payload);
      if (event.callId !== options.callId || event.state !== "recording" || event.targetId !== options.providerUserId ||
        event.targetType?.trim().toLowerCase() !== "user") continue;
      const segment = event.recordings.find(r => r.id === options.recordingId && r.recordingType === options.recordingKind);
      if (segment?.url && (!newest || event.eventTimestampMs > newest.timestamp)) {
        newest = { timestamp: event.eventTimestampMs, url: segment.url };
      }
    } catch { /* An unrelated malformed receipt cannot supply media. */ }
  }
  return newest?.url ?? null;
}
