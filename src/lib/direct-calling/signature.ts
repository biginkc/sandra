import { createPublicKey, verify } from "node:crypto";

export const TIMESTAMP_TOLERANCE_SECS = 300;

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type SignatureResult = { ok: true } | { ok: false; reason: "missing_headers" | "bad_timestamp" | "expired" | "bad_key" | "bad_signature" };

/**
 * Telnyx signs `${telnyx-timestamp}|${raw body}` with Ed25519; the signature is base64 in
 * `telnyx-signature-ed25519` and the account public key (base64, 32 bytes) comes from the portal.
 * Confirmed against the official Telnyx Node SDK (telnyx@7 src/lib/webhooks.ts).
 */
export function verifyTelnyxSignature(input: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  publicKeyBase64: string;
  nowMs: number;
}): SignatureResult {
  if (!input.signature || !input.timestamp) return { ok: false, reason: "missing_headers" };
  if (!/^\d+$/.test(input.timestamp)) return { ok: false, reason: "bad_timestamp" };
  const ts = Number(input.timestamp);
  if (!Number.isSafeInteger(ts)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(Math.floor(input.nowMs / 1000) - ts) > TIMESTAMP_TOLERANCE_SECS) return { ok: false, reason: "expired" };
  if (!BASE64.test(input.publicKeyBase64) || !BASE64.test(input.signature)) {
    return { ok: false, reason: BASE64.test(input.publicKeyBase64) ? "bad_signature" : "bad_key" };
  }
  const keyBytes = Buffer.from(input.publicKeyBase64, "base64");
  const sig = Buffer.from(input.signature, "base64");
  if (keyBytes.length !== 32) return { ok: false, reason: "bad_key" };
  if (sig.length !== 64) return { ok: false, reason: "bad_signature" };
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]), format: "der", type: "spki" });
    const ok = verify(null, Buffer.from(`${input.timestamp}|${input.rawBody}`, "utf8"), key, sig);
    return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}
