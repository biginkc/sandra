/**
 * Browser-safe proof-of-delivery constants and helpers (no Node imports):
 * the lead timeline (a client component) uses these. The Node-only download
 * and Storage code lives in ./proof-copy (server-only).
 */

export const PROOF_BUCKET = "voicemail-drop-proofs";
/** Provider link lifetime. */
export const PROOF_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Signed URL lifetime for the timeline link. */
export const PROOF_SIGNED_URL_TTL_SECONDS = 60;

/** When the provider link stops working: proof_url_at (or completed_at) + 7 days. */
export function proofUrlExpiresAt(drop: { proof_url_at: string | null; completed_at: string | null }): number | null {
  const at = drop.proof_url_at ?? drop.completed_at;
  if (!at) return null;
  const ms = new Date(at).getTime();
  return Number.isFinite(ms) ? ms + PROOF_URL_TTL_MS : null;
}
