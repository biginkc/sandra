import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Playback and machine access to Sandra's own copy of a Dialpad call recording. Authorization is one SQL core
 * (`fn_dialpad_audio_authorize` for people, `fn_dialpad_audio_for_service` for Jev / the coach); a 60 second
 * signed URL is minted only from a path an authorization just returned, and only from the private
 * `dialpad-call-audio` bucket.
 */
export const DIALPAD_AUDIO_BUCKET = "dialpad-call-audio";
export const DIALPAD_AUDIO_URL_SECONDS = 60;

export type DialpadAudioGrant = { audioId: string; path: string; sha256: string | null; durationMs: number | null; mode: "owner" | "rep" };
export type DialpadAudioServiceGrant = { audioId: string; id: string; path: string; sha256: string | null; durationMs: number | null };

type AdminLike = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
  storage: {
    from(bucket: string): {
      createSignedUrl(path: string, expiresIn: number): PromiseLike<{ data: { signedUrl?: string } | null; error: unknown }>;
    };
  };
};

const admin = (): AdminLike => createAdminClient() as unknown as AdminLike;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** Null when denied. Throws only when the authorization lookup itself fails. */
export async function authorizeDialpadAudio(input: { actorId: string; orgId: string; callActivityId: string }): Promise<DialpadAudioGrant | null> {
  const { data, error } = await admin().rpc("fn_dialpad_audio_authorize", {
    p_actor: input.actorId, p_org_id: input.orgId, p_call_activity_id: input.callActivityId,
  });
  if (error) throw new Error(`dialpad audio authorize failed (${error.code ?? "unknown"})`);
  if (!isObject(data)) return null;
  const audioId = text(data.audioId);
  const path = text(data.path);
  if (!audioId || !path || data.bucket !== DIALPAD_AUDIO_BUCKET || (data.mode !== "owner" && data.mode !== "rep")) return null;
  return { audioId, path, sha256: text(data.sha256), durationMs: typeof data.durationMs === "number" ? data.durationMs : null, mode: data.mode };
}

/** A 60 s signed URL for a path an authorization just returned. Null when Storage cannot sign it. */
export async function signDialpadAudioPath(path: string): Promise<{ signedUrl: string; expiresAt: string } | null> {
  const { data, error } = await admin().storage.from(DIALPAD_AUDIO_BUCKET).createSignedUrl(path, DIALPAD_AUDIO_URL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return { signedUrl: data.signedUrl, expiresAt: new Date(Date.now() + DIALPAD_AUDIO_URL_SECONDS * 1000).toISOString() };
}

/** Machines only: the consumer must be in that org's `audio_consumers`; the call, audio row and connection must all belong to `orgId`. */
export async function authorizeDialpadAudioForService(input: { orgId: string; callActivityId: string; consumer: "jev" | "coach_review" }): Promise<DialpadAudioServiceGrant | null> {
  const { data, error } = await admin().rpc("fn_dialpad_audio_for_service", {
    p_org_id: input.orgId, p_call_activity_id: input.callActivityId, p_consumer: input.consumer,
  });
  if (error) throw new Error(`dialpad audio service authorize failed (${error.code ?? "unknown"})`);
  if (!isObject(data)) return null;
  const audioId = text(data.audioId);
  const id = text(data.id);
  const path = text(data.path);
  if (!audioId || !id || !path || data.bucket !== DIALPAD_AUDIO_BUCKET) return null;
  return { audioId, id, path, sha256: text(data.sha256), durationMs: typeof data.durationMs === "number" ? data.durationMs : null };
}
