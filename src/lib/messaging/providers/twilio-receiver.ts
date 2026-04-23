import crypto from "node:crypto";

/**
 * Twilio test-receiver adapter (Tier 1).
 *
 * Sandra doesn't send through Twilio — Dialpad is the outbound provider.
 * We only use Twilio as a TEST DESTINATION: buy a few $1/mo Twilio numbers,
 * point their webhook at `/api/webhooks/test-receiver`, and our E2E tests
 * can assert "Dialpad accepted the send AND the destination carrier
 * actually delivered the payload" by checking the log this receiver
 * persists to `test_sms_log`.
 *
 * This module exports only the signature-verification and payload-parsing
 * helpers — it deliberately doesn't implement `MessagingProvider` because
 * we never SEND through Twilio.
 */

/**
 * Parsed Twilio inbound payload. Twilio POSTs form-encoded bodies; we
 * decode to a strongly-typed shape before persistence.
 *
 * Only the fields we use are typed. The raw form is kept separately for
 * audit.
 */
export type TwilioInboundPayload = {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  /** All form fields, string-valued, preserved for debugging. */
  form: Record<string, string>;
};

/**
 * Verify Twilio's X-Twilio-Signature per their webhook-security docs:
 *
 *   1. Build the canonical string: the full request URL (including
 *      protocol, host, path, and any query string) with every POST form
 *      parameter appended in alphabetical order by key as `key + value`.
 *   2. HMAC-SHA1 the canonical string with the auth token as the key.
 *   3. Base64-encode the digest.
 *   4. Compare (timing-safe) against the `X-Twilio-Signature` header.
 *
 * Returns false on any malformed input so callers can safely 401.
 */
export function verifyTwilioSignature(params: {
  authToken: string;
  fullUrl: string;
  form: Record<string, string>;
  signatureHeader: string | null;
}): boolean {
  if (!params.signatureHeader) return false;

  const sortedKeys = Object.keys(params.form).sort();
  let canonical = params.fullUrl;
  for (const k of sortedKeys) {
    canonical += k + params.form[k];
  }

  const expected = crypto
    .createHmac("sha1", params.authToken)
    .update(canonical)
    .digest("base64");

  // Both strings must be the same length for timingSafeEqual.
  const a = Buffer.from(expected);
  const b = Buffer.from(params.signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Decode a form-encoded Twilio webhook body into a flat key/value map
 * plus the typed subset we care about. Returns `null` when the payload
 * is missing required fields — caller should 400 in that case.
 */
export function parseTwilioInbound(
  rawBody: string,
): TwilioInboundPayload | null {
  const params = new URLSearchParams(rawBody);
  const form: Record<string, string> = {};
  for (const [k, v] of params.entries()) form[k] = v;

  const messageSid = form["MessageSid"] ?? form["SmsMessageSid"];
  const from = form["From"];
  const to = form["To"];
  const body = form["Body"];
  if (!messageSid || !from || !to || body == null) return null;

  return { messageSid, from, to, body, form };
}
