import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import type { DirectCallFullRow } from "./store";
import type { TelnyxRecording } from "./telnyx";

export const DIRECT_RECORDINGS_BUCKET = "sandra-direct-recordings";
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

// The generated Supabase type intentionally lags this additive migration;
// this tiny service-role adapter keeps the new table out of client-facing
// generated types until the next schema regeneration.
type Db = {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  storage: { from(bucket: string): { upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }): Promise<{ error: { message?: string } | null }> } };
};

export type DirectRecordingSaved = {
  recordingId: string;
  callControlId: string;
  callLegId: string | null;
  callSessionId: string | null;
  occurredAt: string | null;
};

type Envelope = { data?: { event_type?: unknown; occurred_at?: unknown; payload?: Record<string, unknown> } };

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseDirectRecordingSaved(rawBody: string): DirectRecordingSaved | null {
  let envelope: Envelope;
  try { envelope = JSON.parse(rawBody) as Envelope; } catch { return null; }
  if (envelope.data?.event_type !== "call.recording.saved") return null;
  const payload = envelope.data.payload ?? {};
  const recordingId = stringValue(payload.recording_id);
  const callControlId = stringValue(payload.call_control_id);
  if (!recordingId || !callControlId) return null;
  const occurred = stringValue(envelope.data.occurred_at);
  return {
    recordingId,
    callControlId,
    callLegId: stringValue(payload.call_leg_id),
    callSessionId: stringValue(payload.call_session_id),
    occurredAt: occurred && !Number.isNaN(Date.parse(occurred)) ? new Date(occurred).toISOString() : null,
  };
}

function safePart(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value)) throw new Error("invalid_recording_identity");
  return value;
}

function wavDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 44 || String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WAVE") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate: number | null = null;
  let dataSize: number | null = null;
  while (offset + 8 <= bytes.length) {
    const kind = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length) break;
    if (kind === "fmt " && size >= 12) byteRate = view.getUint32(body + 8, true);
    if (kind === "data") { dataSize = size; break; }
    offset = body + size + (size % 2);
  }
  return byteRate && dataSize !== null ? Math.max(0, Math.floor(dataSize / byteRate)) : null;
}

async function readAudio(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("invalid_recording_url");
  } catch { throw new Error("invalid_recording_url"); }
  const response = await fetchImpl(parsed, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`recording_download_${response.status}`);
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (contentLength !== null && (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > MAX_AUDIO_BYTES)) throw new Error("recording_size_invalid");
  if (!response.body) throw new Error("recording_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_AUDIO_BYTES) {
      await reader.cancel();
      throw new Error("recording_size_invalid");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES || wavDurationSeconds(bytes) === null) throw new Error("recording_wav_invalid");
  return bytes;
}

function asDb(admin: unknown): Db { return admin as Db; }

export function createDirectRecordingHandler(options: {
  admin?: unknown;
  getRecording: (recordingId: string) => Promise<TelnyxRecording>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}) {
  const admin = asDb(options.admin ?? createAdminClient());
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  return async (row: DirectCallFullRow, recording: DirectRecordingSaved): Promise<void> => {
    if (!row.seller_leg_id || recording.callControlId !== row.seller_leg_id) throw new Error("recording_leg_mismatch");
    const claimed = await admin.rpc("direct_call_recording_claim", {
      p_direct_call_id: row.id,
      p_provider_recording_id: recording.recordingId,
      p_provider_call_control_id: recording.callControlId,
      p_provider_call_leg_id: recording.callLegId,
      p_provider_call_session_id: recording.callSessionId,
      p_now: now().toISOString(),
      p_attempt_cap: 8,
      p_lease_secs: 900,
    });
    if (claimed.error) throw new Error(claimed.error.message ?? "recording_claim_failed");
    const claimRow = Array.isArray(claimed.data) ? claimed.data[0] as { should_capture?: boolean; status?: string; storage_path?: string | null } | undefined : claimed.data as { should_capture?: boolean; status?: string; storage_path?: string | null } | null;
    if (!claimRow?.should_capture) {
      // An available capture may have won a concurrent webhook while its activity
      // row was still absent. Re-sync that row, but never start a second download.
      if (claimRow?.status === "available" && claimRow.storage_path) await syncActivityRecording(admin, row.id, recording.recordingId);
      return;
    }
    try {
      const provider = await options.getRecording(recording.recordingId);
      if (provider.status !== "completed" && provider.status !== "complete" && provider.status !== "available") throw new Error("recording_not_completed");
      if (!provider.downloadUrlWav) throw new Error("recording_download_missing");
      const bytes = await readAudio(provider.downloadUrlWav, fetchImpl);
      const path = `${safePart(row.org_id)}/${safePart(row.id)}/${safePart(provider.recordingId)}.wav`;
      const upload = await admin.storage.from(DIRECT_RECORDINGS_BUCKET).upload(path, bytes, { contentType: "audio/wav", upsert: true });
      if (upload.error) throw new Error(upload.error.message ?? "recording_storage_failed");
      const duration = wavDurationSeconds(bytes);
      if (duration === null) throw new Error("recording_wav_invalid");
      const marked = await admin.rpc("direct_call_recording_mark_available", {
        p_provider_recording_id: recording.recordingId,
        p_direct_call_id: row.id,
        p_storage_bucket: DIRECT_RECORDINGS_BUCKET,
        p_storage_path: path,
        p_duration_seconds: duration,
        p_now: now().toISOString(),
      });
      if (marked.error) throw new Error(marked.error.message ?? "recording_available_failed");
      const markedAvailable = marked.data === true || (Array.isArray(marked.data) && marked.data[0] === true);
      if (!markedAvailable) throw new Error("recording_available_not_persisted");
      await syncActivityRecording(admin, row.id, recording.recordingId);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "recording_capture_failed";
      const failed = await admin.rpc("direct_call_recording_mark_failed", {
        p_provider_recording_id: recording.recordingId,
        p_direct_call_id: row.id,
        p_error_code: "capture_failed",
        p_error_message: message,
        p_now: now().toISOString(),
      });
      if (failed.error) throw new Error(failed.error.message ?? "recording_failure_persist_failed");
      // A concurrent capture can complete after this attempt started. Its
      // available state is protected by the SQL transition; sync is best effort
      // here and the durable sweep retries it without downgrading the ledger.
      try { await syncActivityRecording(admin, row.id, recording.recordingId); } catch { /* retry on sweep */ }
      throw error;
    }
  };
}

async function syncActivityRecording(adminValue: unknown, directCallId: string, providerRecordingId: string) {
  const admin = asDb(adminValue);
  const activity = await admin.from("call_activities").select("id").eq("direct_call_id", directCallId).maybeSingle();
  if (activity.error) throw new Error(activity.error.message ?? "recording_activity_lookup_failed");
  if (!activity.data?.id) return;
  const result = await admin.rpc("direct_call_recording_sync_activity", {
    p_direct_call_id: directCallId,
    p_call_activity_id: activity.data.id,
    p_provider_recording_id: providerRecordingId,
  });
  if (result.error) throw new Error(result.error.message ?? "recording_activity_sync_failed");
}

/** Copies a saved-before-wrapup ledger row into the existing activity child table. */
export async function attachPendingDirectRecording(directCallId: string, activityId: string, adminValue?: unknown): Promise<void> {
  const admin = asDb(adminValue ?? createAdminClient());
  const stage = await admin.from("direct_call_recordings").select("provider_recording_id").eq("direct_call_id", directCallId).maybeSingle();
  if (stage.error) throw new Error(stage.error.message ?? "recording_lookup_failed");
  if (!stage.data?.provider_recording_id) return;
  const result = await admin.rpc("direct_call_recording_sync_activity", {
    p_direct_call_id: directCallId,
    p_call_activity_id: activityId,
    p_provider_recording_id: stage.data.provider_recording_id,
  });
  if (result.error) throw new Error(result.error.message ?? "recording_activity_sync_failed");
}
