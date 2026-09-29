import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Dialpad signs webhook bodies as a compact HS256 JWT when a secret is set on
 * the webhook; with no secret it posts plain JSON, which must never be
 * accepted. The body is the raw JWT string.
 *
 * The decoded payload is returned as text, unparsed and unmodified, so 64-bit
 * ids (call_id can exceed 2^53) keep every digit all the way to the database.
 */

export const DIALPAD_WEBHOOK_MAX_BYTES = 256 * 1024;

export type DialpadJwtFailure = 'too_large' | 'malformed' | 'unsupported_alg' | 'bad_signature' | 'bad_payload';

export type DialpadJwtVerification =
  | { ok: true; payloadText: string; secretIndex: number }
  | { ok: false; reason: DialpadJwtFailure };

const SEGMENT = /^[A-Za-z0-9_-]+$/;

function decodeSegment(segment: string): Buffer | null {
  const decoded = Buffer.from(segment, 'base64url');
  return decoded.toString('base64url') === segment ? decoded : null;
}

function utf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verifies an HS256 JWT against every candidate secret (current and, during a
 * rotation window, previous) without short-circuiting. The algorithm is pinned
 * to HS256: "none", other HMAC sizes and asymmetric algorithms are refused, as
 * is any token carrying a critical-header extension we do not understand.
 * Returns the index of the secret that verified.
 */
export function verifyDialpadWebhookJwt(rawBody: string, secrets: readonly string[]): DialpadJwtVerification {
  if (rawBody.length > DIALPAD_WEBHOOK_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const usable = secrets.filter((secret) => typeof secret === 'string' && secret.length > 0);
  if (usable.length === 0) return { ok: false, reason: 'bad_signature' };

  const token = rawBody.trim();
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) return { ok: false, reason: 'malformed' };
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const headerBytes = decodeSegment(headerSegment);
  const headerText = headerBytes ? utf8(headerBytes) : null;
  let header: unknown;
  try {
    header = headerText === null ? undefined : JSON.parse(headerText);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPlainObject(header)) return { ok: false, reason: 'malformed' };
  if (header.alg !== 'HS256' || 'crit' in header) return { ok: false, reason: 'unsupported_alg' };

  const signature = decodeSegment(signatureSegment);
  if (!signature || signature.length !== 32) return { ok: false, reason: 'bad_signature' };

  const signingInput = `${headerSegment}.${payloadSegment}`;
  let verifiedIndex = -1;
  usable.forEach((secret, index) => {
    const expected = createHmac('sha256', secret).update(signingInput).digest();
    if (timingSafeEqual(expected, signature) && verifiedIndex === -1) verifiedIndex = index;
  });
  if (verifiedIndex === -1) return { ok: false, reason: 'bad_signature' };

  const payloadBytes = decodeSegment(payloadSegment);
  const payloadText = payloadBytes ? utf8(payloadBytes) : null;
  if (payloadText === null) return { ok: false, reason: 'bad_payload' };
  try {
    if (!isPlainObject(JSON.parse(payloadText))) return { ok: false, reason: 'bad_payload' };
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  return { ok: true, payloadText, secretIndex: verifiedIndex };
}
