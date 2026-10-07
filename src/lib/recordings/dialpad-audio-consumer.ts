import { authorizeDialpadAudioForService, signDialpadAudioPath } from "./dialpad-audio-playback";

export type DialpadAudioConsumer = "jev" | "coach_review";

export type DialpadCallAudio = {
  /** Stable id: `dpa_<audio id>`. */
  id: string;
  sha256: string | null;
  durationMs: number | null;
  signedUrl: string;
  expiresAt: string;
};

/**
 * The only way Jev or the coach read stored Dialpad call audio. Tenant-bound: `orgId` must own the call activity,
 * the audio row and the Dialpad connection, and must list `consumer` in its own `audio_consumers` (default none).
 * Every grant is written to `dialpad_audio_access_log`. Returns null when denied (or when no URL can be signed);
 * a signed URL is minted only after the authorization returned a grant.
 */
export async function getDialpadCallAudio(input: { orgId: string; callActivityId: string; consumer: DialpadAudioConsumer }): Promise<DialpadCallAudio | null> {
  const grant = await authorizeDialpadAudioForService(input);
  if (!grant) return null;
  const signed = await signDialpadAudioPath(grant.path);
  if (!signed) return null;
  return { id: grant.id, sha256: grant.sha256, durationMs: grant.durationMs, signedUrl: signed.signedUrl, expiresAt: signed.expiresAt };
}
