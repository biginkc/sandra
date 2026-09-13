import "server-only";
import { createDialpadVoiceAdminClient } from "./database";

export async function loadOwnedDialpadSegments(orgId: string, callId: string) {
  const admin = createDialpadVoiceAdminClient();
  const { data, error } = await admin.from("dialpad_recording_artifacts")
    .select("id,org_id,provider_call_id,status,storage_bucket,storage_path,content_sha256,byte_count,decoded_duration_seconds,verified_at,media_type")
    .eq("org_id", orgId).eq("provider_call_id", callId).eq("status", "available").order("id");
  if (error) throw new Error("Recording lookup failed");
  // Defense in depth: never sign arbitrary paths even with service-role access.
  const segments = (data ?? []).filter(r => r.org_id === orgId && r.provider_call_id === callId &&
    r.status === "available" && r.verified_at && Number.isFinite(Date.parse(r.verified_at)) &&
    r.byte_count !== null && r.byte_count > 0 && r.decoded_duration_seconds !== null && r.decoded_duration_seconds > 0 &&
    r.content_sha256 && /^[a-f0-9]{64}$/.test(r.content_sha256) && r.storage_bucket &&
    r.storage_path && ["wav", "mp3", "ogg", "flac"].some(ext => r.storage_path === `${orgId}/${callId}/${r.id}/${r.content_sha256}.${ext}`));
  return { admin, segments };
}

export const publicRecordingSegments = (segments: Awaited<ReturnType<typeof loadOwnedDialpadSegments>>["segments"]) =>
  segments.map(r => ({ artifactId: r.id, durationSeconds: r.decoded_duration_seconds }));

/** Call only after a session/RLS lookup authorized the parent call activity. */
export async function ownedDialpadPlayback(orgId: string, callId: string, artifactId: string | null) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (artifactId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artifactId)) {
    return json({ error: "Invalid recording selection", error_code: "invalid_artifact" }, 400);
  }
  try {
    const { admin, segments } = await loadOwnedDialpadSegments(orgId, callId);
    if (!segments.length) return json({ error: "Recording is not retained yet", error_code: "recording_not_available" }, 409);
    if (!artifactId && segments.length > 1) return json({ error: "Select a recording segment", error_code: "recording_multiple_segments", recordingSegments: publicRecordingSegments(segments) }, 409);
    const selected = artifactId ? segments.find(r => r.id === artifactId) : segments[0];
    if (!selected) return json({ error: "Recording not found", error_code: "not_found" }, 404);
    const bucket = selected.storage_bucket!;
    const privacy = await admin.storage.getBucket(bucket);
    if (privacy.error || privacy.data?.public !== false) return json({ error: "Private recording storage unavailable", error_code: "recording_not_available" }, 409);
    const ttl = 60;
    const signed = await admin.storage.from(bucket).createSignedUrl(selected.storage_path!, ttl);
    if (signed.error || !signed.data?.signedUrl) throw new Error("Signing failed");
    return json({ signedUrl: signed.data.signedUrl, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), artifactId: selected.id });
  } catch { return json({ error: "Recording playback unavailable", error_code: "playback_unavailable" }, 503); }
}
