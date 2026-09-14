import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DialpadVoiceDatabase } from "./database.generated";
import type {EventConfigurationDatabase} from "./event-configuration-database";
import { normalizeDialpadCallEvent } from "./call-event";

/** Receipts in this table were authenticated before insertion. This supplies
 * only a candidate URL; the downloader still enforces its host/path/media rules.
 * Caller first verifies the same recording ID/type in an authenticated Call Get.
 */
export async function signedRecordingUrl(client: SupabaseClient<DialpadVoiceDatabase>, options: {
  orgId: string; callId: string; providerUserId: string; recordingId: string; recordingKind: string; providerCompanyId: string;
}): Promise<string | null> {
  const scoped = client as unknown as SupabaseClient<EventConfigurationDatabase>;
  const { data, error } = await scoped.from("dialpad_voice_event_inbox").select("payload,org_id,webhook_source_id,status")
    .eq("org_id", options.orgId).filter("payload->>call_id", "eq", options.callId)
    .filter("payload->>state", "eq", "recording").order("received_at", { ascending: false }).limit(20);
  if (error) throw new Error("Signed recording source unavailable");
  let newest: { timestamp: number; url: string } | null = null;
  for (const row of data ?? []) {
    if (row.org_id !== options.orgId || !row.webhook_source_id || row.status === 'quarantined' || row.status === 'failed') continue;
    const source = await scoped.from('dialpad_voice_webhook_sources').select('*').eq('org_id',options.orgId).eq('id',row.webhook_source_id).maybeSingle();
    if(source.error)throw new Error('Signed recording source unavailable');
    const s=source.data;if(!s||s.org_id!==options.orgId||s.id!==row.webhook_source_id)continue;
    const history=await scoped.from('dialpad_connection_revisions').select('*').eq('org_id',options.orgId).eq('connection_id',s.connection_id).eq('config_version',s.connection_version).maybeSingle();
    if(history.error)throw new Error('Signed recording source unavailable');
    const h=history.data;if(!h||h.org_id!==options.orgId||h.connection_id!==s.connection_id||h.config_version!==s.connection_version||h.provider_company_id!==options.providerCompanyId)continue;
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
