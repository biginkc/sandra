import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Dialpad sends the signed JWT as the request body, not an auth header.
 * This verifies transport authenticity only. The receiver must separately
 * validate event identity, persist before acknowledging, and deduplicate.
 */
export function verifyDialpadVoiceEvent(
  rawBody: string,
  secret: string,
): Record<string, unknown> | null {
  if (!secret.trim() || Buffer.byteLength(rawBody) > 1_048_576) return null;
  const parts = rawBody.trim().split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  const [header, payload, signature] = parts;
  try {
    const metadata = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    if (!metadata || metadata.alg !== "HS256" || metadata.crit !== undefined) return null;
    const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
    const received = Buffer.from(signature, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    const event: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!event || typeof event !== "object" || Array.isArray(event)) return null;
    return event as Record<string, unknown>;
  } catch {
    return null;
  }
}
