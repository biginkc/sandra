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
    const ledger = admin.from("direct_call_recordings");
    const existingResult = await ledger.select("*").eq("provider_recording_id", recording.recordingId).maybeSingle();
    if (existingResult.error) throw new Error(existingResult.error.message);
    const existing = existingResult.data as { status?: string; storage_path?: string | null } | null;
    if (existing?.status === "available" && existing.storage_path) return;
    const base = {
      direct_call_id: row.id,
      provider_recording_id: recording.recordingId,
      provider_call_control_id: recording.callControlId,
      provider_call_leg_id: recording.callLegId,
      provider_call_session_id: recording.callSessionId,
      status: "pending",
      error_code: null,
      error_message: null,
      attempt_count: (Number((existing as { attempt_count?: number } | null)?.attempt_count) || 0) + 1,
      last_attempt_at: now().toISOString(),
      updated_at: now().toISOString(),
    };
    const saved = await ledger.upsert(base, { onConflict: "provider_recording_id" }).select("*").single();
    if (saved.error) throw new Error(saved.error.message);
    try {
      const provider = await options.getRecording(recording.recordingId);
      if (provider.status !== "completed" && provider.status !== "complete" && provider.status !== "available") throw new Error("recording_not_completed");
      if (!provider.downloadUrlWav) throw new Error("recording_download_missing");
      const bytes = await readAudio(provider.downloadUrlWav, fetchImpl);
      const path = `${safePart(row.org_id)}/${safePart(row.id)}/${safePart(provider.recordingId)}.wav`;
      const upload = await admin.storage.from(DIRECT_RECORDINGS_BUCKET).upload(path, bytes, { contentType: "audio/wav", upsert: true });
      if (upload.error) throw new Error(upload.error.message ?? "recording_storage_failed");
      const duration = wavDurationSeconds(bytes);
      const update = await ledger.update({ status: "available", storage_bucket: DIRECT_RECORDINGS_BUCKET, storage_path: path, duration_seconds: duration, error_code: null, error_message: null, updated_at: now().toISOString() }).eq("provider_recording_id", recording.recordingId);
      if (update.error) throw new Error(update.error.message);
      await syncActivityRecording(admin, row.id, recording.recordingId);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "recording_capture_failed";
      await ledger.update({ status: "failed", error_code: "capture_failed", error_message: message, updated_at: now().toISOString() }).eq("provider_recording_id", recording.recordingId);
      await syncActivityRecording(admin, row.id, recording.recordingId);
      throw error;
    }
  };
}

async function syncActivityRecording(adminValue: unknown, directCallId: string, providerRecordingId: string) {
  const admin = asDb(adminValue);
  const activity = await admin.from("call_activities").select("id").eq("direct_call_id", directCallId).maybeSingle();
  if (activity.error || !activity.data?.id) return;
  const stage = await admin.from("direct_call_recordings").select("*").eq("provider_recording_id", providerRecordingId).single();
  if (stage.error || !stage.data) return;
  const result = await admin.from("call_recordings").upsert({
    call_activity_id: activity.data.id,
    status: stage.data.status,
    provider_recording_id: stage.data.provider_recording_id,
    provider_call_control_id: stage.data.provider_call_control_id,
    provider_call_leg_id: stage.data.provider_call_leg_id,
    provider_call_session_id: stage.data.provider_call_session_id,
    storage_bucket: stage.data.storage_bucket,
    storage_path: stage.data.storage_path,
    duration_seconds: stage.data.duration_seconds,
    error_code: stage.data.error_code,
    error_message: stage.data.error_message,
  }, { onConflict: "provider_recording_id" });
  if (result.error) throw new Error(result.error.message);
}

/** Copies a saved-before-wrapup ledger row into the existing activity child table. */
export async function attachPendingDirectRecording(directCallId: string, activityId: string, adminValue?: unknown): Promise<void> {
  const admin = asDb(adminValue ?? createAdminClient());
  const stage = await admin.from("direct_call_recordings").select("*").eq("direct_call_id", directCallId).maybeSingle();
  if (stage.error || !stage.data) return;
  const result = await admin.from("call_recordings").upsert({
    call_activity_id: activityId,
    status: stage.data.status,
    provider_recording_id: stage.data.provider_recording_id,
    provider_call_control_id: stage.data.provider_call_control_id,
    provider_call_leg_id: stage.data.provider_call_leg_id,
    provider_call_session_id: stage.data.provider_call_session_id,
    storage_bucket: stage.data.storage_bucket,
    storage_path: stage.data.storage_path,
    duration_seconds: stage.data.duration_seconds,
    error_code: stage.data.error_code,
    error_message: stage.data.error_message,
  }, { onConflict: "provider_recording_id" });
  if (result.error) throw new Error(result.error.message);
}
