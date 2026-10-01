 
// Telnyx webhook signature verification: Ed25519 over `${timestamp}|${rawBody}`.
import { createPublicKey, verify } from "node:crypto";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export const TOLERANCE_SECS = 300;

export type VerifyResult = { ok: true } | { ok: false; reason: "bad-key" | "missing-headers" | "expired" | "bad-signature" };

export function verifyTelnyxSignature(opts: {
  publicKeyBase64: string;
  signatureBase64: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | string;
  nowMs?: number;
}): VerifyResult {
  if (!opts.signatureBase64 || !opts.timestamp) return { ok: false, reason: "missing-headers" };
  const ts = Number(opts.timestamp);
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TOLERANCE_SECS) return { ok: false, reason: "expired" };
  let key;
  try {
    const raw = Buffer.from(opts.publicKeyBase64, "base64");
    if (raw.length !== 32) return { ok: false, reason: "bad-key" };
    key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
  } catch {
    return { ok: false, reason: "bad-key" };
  }
  const body = typeof opts.rawBody === "string" ? Buffer.from(opts.rawBody) : opts.rawBody;
  const msg = Buffer.concat([Buffer.from(`${opts.timestamp}|`), body]);
  let ok = false;
  try {
    ok = verify(null, msg, key, Buffer.from(opts.signatureBase64, "base64"));
  } catch {
    ok = false;
  }
  return ok ? { ok: true } : { ok: false, reason: "bad-signature" };
}
