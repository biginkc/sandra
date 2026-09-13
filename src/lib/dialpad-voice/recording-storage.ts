import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DialpadVoiceDatabase, DialpadVoiceTables } from "./database.generated";
import type { RecordingDownloadResult } from "./recording-download";

type Artifact = DialpadVoiceTables["dialpad_recording_artifacts"]["Row"];
export type ClaimedRecordingArtifact = Pick<Artifact, "id" | "org_id" | "provider_call_id" | "provider_recording_id" | "status" | "lease_token">;
export type RecordingStorageResult =
  | { ok: true; storagePath: string; verifiedAt: string }
  | { ok: false; reason: "invalid_input" | "private_bucket_required" | "upload_failed" | "readback_failed" | "readback_mismatch" | "metadata_failed" | "lost_lease" };
const MIME = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", flac: "audio/flac" };
const MAX_BYTES = 128 * 1024 * 1024;

/** Only marks available after authenticated storage read-back matches decoded
 * bytes. Upload conflict is safe only when the same verification succeeds.
 * On lost lease, leave the deterministic object for the current worker to reuse;
 * deleting it could destroy another worker's successful result. */
export async function retainDialpadRecording(options: {
  client: SupabaseClient<DialpadVoiceDatabase>;
  artifact: ClaimedRecordingArtifact;
  download: Extract<RecordingDownloadResult, { ok: true }>;
  bucket: string;
}): Promise<RecordingStorageResult> {
  const { client, artifact, download, bucket } = options;
  const fail = (reason: Extract<RecordingStorageResult, { ok: false }>["reason"]): RecordingStorageResult => ({ ok: false, reason });
  const segment = /^[A-Za-z0-9_-]+$/;
  if (![artifact.id, artifact.org_id, artifact.provider_call_id, bucket].every(v => typeof v === "string" && segment.test(v)) ||
      typeof artifact.provider_recording_id !== "string" || !artifact.provider_recording_id.trim() || artifact.provider_recording_id.length > 500 ||
      artifact.status !== "processing" || !artifact.lease_token || download.verification !== "decoded" ||
      !Buffer.isBuffer(download.bytes) || download.bytes.length === 0 || download.bytes.length > MAX_BYTES ||
      !Number.isFinite(download.decoded.durationSeconds) || download.decoded.durationSeconds <= 0 ||
      !Object.hasOwn(MIME, download.format) || createHash("sha256").update(download.bytes).digest("hex") !== download.sha256) return fail("invalid_input");
  const storagePath = `${artifact.org_id}/${artifact.provider_call_id}/${artifact.id}/${download.sha256}.${download.format}`;
  let stage: Extract<RecordingStorageResult, { ok: false }>["reason"] = "private_bucket_required";
  try {
    const privacy = await client.storage.getBucket(bucket);
    if (privacy.error || !privacy.data || privacy.data.public !== false) return fail("private_bucket_required");
    const store = client.storage.from(bucket);
    stage = "upload_failed";
    const upload = await store.upload(storagePath, download.bytes, { upsert: false, contentType: MIME[download.format], cacheControl: "0" });
    if (upload.error) {
      const status = "statusCode" in upload.error ? String(upload.error.statusCode) : "";
      const duplicate400 = (status === "400" || upload.error.status === 400) &&
        (upload.error.message === "Asset Already Exists" || upload.error.message === "The resource already exists" ||
          ["ResourceAlreadyExists", "KeyAlreadyExists"].includes(status));
      if (status !== "409" && upload.error.status !== 409 && !duplicate400) return fail("upload_failed");
    }
    stage = "readback_failed";
    const read = await store.download(storagePath);
    if (read.error || !read.data) return fail("readback_failed");
    if (read.data.size !== download.bytes.length || read.data.size > MAX_BYTES) return fail("readback_mismatch");
    const retained = Buffer.from(await read.data.arrayBuffer());
    if (retained.length !== download.bytes.length || createHash("sha256").update(retained).digest("hex") !== download.sha256) return fail("readback_mismatch");
    const verifiedAt = new Date().toISOString();
    stage = "metadata_failed";
    const updated = await client.from("dialpad_recording_artifacts").update({
      status: "available", storage_bucket: bucket, storage_path: storagePath,
      content_sha256: download.sha256, byte_count: retained.length,
      decoded_duration_seconds: download.decoded.durationSeconds, media_type: MIME[download.format],
      verified_at: verifiedAt, updated_at: verifiedAt, lease_token: null, lease_expires_at: null, last_error_code: null,
    }).eq("org_id", artifact.org_id).eq("id", artifact.id).eq("status", "processing")
      .eq("lease_token", artifact.lease_token).select("id");
    if (updated.error) return fail("metadata_failed");
    if (updated.data?.length !== 1) return fail("lost_lease");
    return { ok: true, storagePath, verifiedAt };
  } catch { return fail(stage); }
}
