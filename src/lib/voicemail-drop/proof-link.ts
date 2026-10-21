import { PROOF_SIGNED_URL_TTL_SECONDS, proofUrlExpiresAt } from "./proof-shared";

export type ProofLinkRow = {
  org_id: string;
  proof_url: string | null;
  proof_url_at: string | null;
  completed_at: string | null;
  proof_storage_path: string | null;
};

/** Drop Cowboy's own link, only while it still works (7 days). */
export function freshProviderProofUrl(
  row: Pick<ProofLinkRow, "proof_url" | "proof_url_at" | "completed_at">,
  now: number = Date.now(),
): string | null {
  if (!row.proof_url?.startsWith("https://")) return null;
  const expiresAt = proofUrlExpiresAt(row);
  return expiresAt !== null && now < expiresAt ? row.proof_url : null;
}

/** Whether the timeline should offer a proof link at all. */
export function hasProofOfDelivery(
  row: Pick<ProofLinkRow, "proof_url" | "proof_url_at" | "completed_at" | "proof_storage_path">,
  now: number = Date.now(),
): boolean {
  return Boolean(row.proof_storage_path) || freshProviderProofUrl(row, now) !== null;
}

/**
 * Stored copy first (a short-lived signed URL; the path must sit under the
 * drop's own org), then the provider link while it is within 7 days.
 */
export async function resolveProofLink(
  row: ProofLinkRow,
  sign: (path: string, seconds: number) => Promise<string | null>,
  now: number = Date.now(),
): Promise<string | null> {
  if (row.proof_storage_path && row.proof_storage_path.startsWith(`${row.org_id}/`)) {
    const signed = await sign(row.proof_storage_path, PROOF_SIGNED_URL_TTL_SECONDS);
    if (signed) return signed;
  }
  return freshProviderProofUrl(row, now);
}
