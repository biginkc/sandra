import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DialpadVoiceDatabase } from "./database.generated";
import { DialpadVoiceClient, DialpadVoiceError } from "./client";
import { downloadDialpadRecording, type RecordingDecoder } from "./recording-download";
import { retainDialpadRecording } from "./recording-storage";

function id(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** One budget-reserved call detail read and one artifact per invocation. No
 * provider mutation. A verified private read-back is required for availability.
 */
export async function processDialpadRecording(options: {
  client: SupabaseClient<DialpadVoiceDatabase>;
  orgId: string;
  providerUserId: string;
  apiKey: string;
  bucket: string;
  decode: RecordingDecoder;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { client, orgId } = options;
  const claimed = await client.rpc("fn_claim_dialpad_recording", { p_org_id: orgId, p_lease_seconds: 300 });
  if (claimed.error) throw new Error("Recording queue unavailable");
  const artifact = claimed.data?.[0];
  if (!artifact) return "idle";
  if (artifact.org_id !== orgId || !artifact.lease_token) throw new Error("Recording lease invalid");
  let status: "retry" | "denied" | "failed" = "retry";
  let errorCode = "recording_processing_unavailable";
  try {
    const api = new DialpadVoiceClient(options.apiKey, { fetch: options.fetchImpl });
    const call = await api.getCall(artifact.provider_call_id);
    const target = object(call.target);
    if (id(call.call_id) !== artifact.provider_call_id || id(target?.id) !== options.providerUserId ||
      typeof target?.type !== "string" || target.type.trim().toLowerCase() !== "user") {
      status = "denied";
      errorCode = "recording_identity_mismatch";
    } else {
      const segments = Array.isArray(call.recording_details) ? call.recording_details : [];
      const segment = segments.map(object).find((value) => value && id(value.id) === artifact.provider_recording_id);
      if (!segment || typeof segment.url !== "string" || segment.recording_type !== artifact.recording_kind) {
        errorCode = "recording_not_yet_available";
      } else {
        const download = await downloadDialpadRecording({
          url: segment.url, apiKey: options.apiKey, decode: options.decode, fetchImpl: options.fetchImpl,
        });
        if (!download.ok) {
          errorCode = `recording_${download.reason}`;
          if (download.reason === "login_required") status = "denied";
        } else {
          const expectedMs = Number(segment.duration);
          const actualSeconds = download.decoded.durationSeconds;
          if (segment.duration != null && Number.isFinite(expectedMs) && expectedMs > 0 &&
            Math.abs(actualSeconds - expectedMs / 1000) > Math.max(2, expectedMs / 1000 * 0.05)) {
            errorCode = "recording_duration_mismatch";
          } else {
            const stored = await retainDialpadRecording({ client, artifact, download, bucket: options.bucket });
            if (stored.ok) return "available";
            if (stored.reason === "lost_lease") return "lease_lost";
            errorCode = `recording_${stored.reason}`;
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof DialpadVoiceError && error.status === 429) {
      errorCode = "recording_rate_limited";
      const deferred = await client.rpc("fn_defer_dialpad_detail_budget", { p_org_id: orgId, p_seconds: 60 });
      if (deferred.error) throw new Error("Recording rate budget unavailable");
    }
  }
  if (status === "retry" && artifact.attempt_count >= 8) status = "failed";
  const updated = await client.from("dialpad_recording_artifacts").update({
    status, last_error_code: errorCode,
    next_attempt_at: new Date(Date.now() + Math.min(3600, 60 * 2 ** Math.max(0, artifact.attempt_count - 1)) * 1000).toISOString(),
    lease_token: null, lease_expires_at: null,
  }).eq("org_id", orgId).eq("id", artifact.id).eq("status", "processing")
    .eq("lease_token", artifact.lease_token).select("id");
  if (updated.error) throw new Error("Recording receipt update unavailable");
  return updated.data?.length === 1 ? status : "lease_lost";
}
