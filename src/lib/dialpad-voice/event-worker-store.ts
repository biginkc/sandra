import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DialpadVoiceDatabase } from "./database.generated";
import { DialpadEvidenceRejected, type VoiceEventWorkerStore } from "./event-worker";

export function createVoiceEventWorkerStore(
  client: SupabaseClient<DialpadVoiceDatabase>,
  orgId: string,
  ingestInsights?: VoiceEventWorkerStore["ingestInsights"],
  authorizeEvent?:VoiceEventWorkerStore["authorizeEvent"],
): VoiceEventWorkerStore {
  return {
    async authorizeEvent(receipt,event){if(!authorizeEvent)throw new DialpadEvidenceRejected();await authorizeEvent(receipt,event);},
    async ingestInsights(receipt, event) {
      if (!ingestInsights) throw new Error("Voice insights ingestion unavailable");
      await ingestInsights(receipt, event);
    },
    async claim() {
      const { data, error } = await client.rpc("fn_claim_dialpad_voice_events", {
        p_org_id: orgId, p_limit: 10, p_lease_seconds: 120,
      });
      if (error || !data) throw new Error("Voice queue unavailable");
      return data.map((row) => {
        if (!row.lease_token || row.org_id !== orgId) throw new Error("Voice lease invalid");
        return { id: row.id, orgId: row.org_id, leaseToken: row.lease_token, attemptCount: row.attempt_count, payload: row.payload, webhookSourceId:(row as typeof row & {webhook_source_id?:string|null}).webhook_source_id };
      });
    },
    async recordEvidence(intentId, receiptId) {
      const { data, error } = await client.rpc("fn_record_dialpad_acquisition_call_start", {
        p_intent_id: intentId, p_receipt_id: receiptId,
      });
      if (error) {
        if (["23514", "22023", "42501", "P0002"].includes(error.code)) throw new DialpadEvidenceRejected();
        throw new Error("Voice evidence unavailable");
      }
      if (!data || typeof data !== "object" || Array.isArray(data) || data.tracked !== true) {
        throw new DialpadEvidenceRejected();
      }
    },
    async enqueueRecordings(receipt, event) {
      if (receipt.orgId !== orgId) throw new DialpadEvidenceRejected();
      if (event.recordings.length === 0) return;
      const { data: intent, error } = await client.from("dialpad_voice_intents")
        .select("id").eq("org_id", orgId).eq("provider_call_id", event.callId).maybeSingle();
      if (error) throw new Error("Voice intent unavailable");
      const rows = event.recordings.map((recording) => {
        if (!recording.recordingType?.trim()) throw new DialpadEvidenceRejected();
        return {
          org_id: orgId, provider_call_id: event.callId, provider_recording_id: recording.id,
          recording_kind: recording.recordingType, intent_id: intent?.id ?? null, status: "pending",
        };
      });
      const queued = await client.from("dialpad_recording_artifacts").upsert(rows, {
        onConflict: "org_id,provider_call_id,provider_recording_id", ignoreDuplicates: true,
      });
      if (queued.error) throw new Error("Voice recording queue unavailable");
      if (intent) {
        // A recording may precede the correlated start event. Fill only the
        // missing verified link; never reset an existing job or retained copy.
        const linked = await client.from("dialpad_recording_artifacts").update({ intent_id: intent.id })
          .eq("org_id", orgId).eq("provider_call_id", event.callId)
          .in("provider_recording_id", event.recordings.map((recording) => recording.id)).is("intent_id", null);
        if (linked.error) throw new Error("Voice recording attribution unavailable");
      }
    },
    async finish(receipt, result) {
      if (receipt.orgId !== orgId) throw new DialpadEvidenceRejected();
      const { data, error } = await client.from("dialpad_voice_event_inbox").update({
        status: result.status, last_error_code: result.errorCode,
        next_attempt_at: result.retryAt ?? new Date().toISOString(),
        processed_at: result.status === "processed" ? new Date().toISOString() : null,
        lease_token: null, lease_expires_at: null,
      }).eq("org_id", orgId).eq("id", receipt.id).eq("status", "processing")
        .eq("lease_token", receipt.leaseToken).gt("lease_expires_at",new Date().toISOString()).select("id");
      if (error) throw new Error("Voice receipt update unavailable");
      return data?.length === 1;
    },
  };
}
