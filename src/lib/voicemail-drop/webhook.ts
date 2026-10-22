import { createHmac, timingSafeEqual } from "node:crypto";

import { classifyReasonCode } from "./reason-codes";
import type {
  VoicemailDropCallbackEvent,
  VoicemailDropSignatureCheck,
  VoicemailDropStatusEvent,
  WebhookHeaders,
} from "./types";

/** Drop Cowboy: "Reject timestamps more than 300 seconds old". */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

function header(headers: WebhookHeaders, name: string): string | null {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name);
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }
  return null;
}

/**
 * X-Signature = "sha256=" + hex HMAC-SHA256(secret, `${X-Timestamp}.${rawBody}`).
 * X-Timestamp is Unix seconds.
 */
export function verifyDropCowboySignature(
  secret: string,
  rawBody: string,
  headers: WebhookHeaders,
  nowMs: number = Date.now(),
  toleranceSeconds: number = WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
): VoicemailDropSignatureCheck {
  const signature = header(headers, "x-signature")?.trim();
  const timestamp = header(headers, "x-timestamp")?.trim();
  if (!secret || !signature || !timestamp) return { valid: false, reason: "missing_headers" };

  if (!/^\d+$/.test(timestamp) || !signature.startsWith("sha256=")) {
    return { valid: false, reason: "bad_format" };
  }
  const provided = signature.slice("sha256=".length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return { valid: false, reason: "bad_format" };

  const ageSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > toleranceSeconds) {
    return { valid: false, reason: "stale" };
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const given = Buffer.from(provided, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { valid: false, reason: "mismatch" };
  }
  return { valid: true };
}

function parseObject(rawBody: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error(`${what}: body is not JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${what}: body is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function status(v: unknown, what: string): "success" | "failure" {
  if (v === "success" || v === "failure") return v;
  throw new Error(`${what}: status must be success or failure`);
}

/**
 * Thrown for a validly signed webhook whose event type Sandra doesn't handle.
 * Callers must acknowledge it with a 2xx: Drop Cowboy pauses an endpoint after
 * 5 non-retriable rejections in a row and drops events while paused.
 */
export class UnsupportedDropCowboyEventError extends Error {
  readonly eventType: string;
  constructor(eventType: string) {
    super(`dropcowboy webhook: unsupported event ${eventType}`);
    this.name = "UnsupportedDropCowboyEventError";
    this.eventType = eventType;
  }
}

export function parseDropCowboyStatusWebhook(rawBody: string): VoicemailDropStatusEvent {
  const body = parseObject(rawBody, "dropcowboy webhook");
  const event = body.event;
  if (event !== "contact.rvm.status" && event !== "contact.rvm.receipt") {
    throw new UnsupportedDropCowboyEventError(String(event));
  }
  const eventId = str(body.event_id);
  if (!eventId) throw new Error("dropcowboy webhook: missing event_id");
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("dropcowboy webhook: missing data");
  }
  const d = data as Record<string, unknown>;
  const info = classifyReasonCode(num(d.reason_code));
  return {
    kind: event === "contact.rvm.receipt" ? "receipt" : "status",
    eventId,
    eventAt: num(body.event_at),
    dropId: str(d.drop_id),
    to: str(d.to),
    contactId: str(d.contact_id),
    campaignType: str(d.campaign_type),
    status: status(d.status, "dropcowboy webhook"),
    reason: str(d.reason),
    reasonCode: info.reasonCode,
    reasonClass: info.reasonClass,
    proofUrl: str(d.proof_of_delivery_url),
    receiptReadyAt: str(d.receipt_ready_at),
    raw: body,
  };
}

export function parseDropCowboyCallback(rawBody: string): VoicemailDropCallbackEvent {
  const body = parseObject(rawBody, "dropcowboy callback");
  const info = classifyReasonCode(num(body.reason_code));
  const fees = [num(body.product_cost), num(body.compliance_fee), num(body.tts_fee)];
  const cost = fees.some((f) => f !== null)
    ? fees.reduce<number>((sum, f) => sum + (f ?? 0), 0)
    : null;
  return {
    kind: "callback",
    foreignId: str(body.foreign_id),
    dropId: str(body.drop_id),
    status: status(body.status, "dropcowboy callback"),
    reason: str(body.reason),
    reasonCode: info.reasonCode,
    reasonClass: info.reasonClass,
    phoneNumber: str(body.phone_number),
    productCode: str(body.product_code),
    proofUrl: str(body.proof_of_delivery_url),
    cost,
    attemptDate: str(body.attempt_date),
    raw: body,
  };
}

/**
 * Drop Cowboy gives every webhook subscription (one per event type) its own
 * signing secret. A delivery is verified only with the secret of the event
 * type it names, so a status event signed with the receipt secret (or the
 * reverse) never verifies.
 */
export const DROPCOWBOY_EVENT_SECRET_ENV = {
  "contact.rvm.status": "DROPCOWBOY_WEBHOOK_SECRET",
  "contact.rvm.receipt": "DROPCOWBOY_RECEIPT_WEBHOOK_SECRET",
  // Fires when a call to the drop line reaches its Forward step; carries the
  // real caller (data.call.from), which forwarding hides from Norma.
  "contact.call.ringing": "DROPCOWBOY_CALL_WEBHOOK_SECRET",
} as const;

export type DropCowboySignedEvent = keyof typeof DROPCOWBOY_EVENT_SECRET_ENV;

export type DropCowboySecretSelection =
  | { kind: "supported"; event: DropCowboySignedEvent; envName: string; secret: string | null }
  | { kind: "unsupported"; event: string }
  | { kind: "unparseable" };

/** Read only the `event` field of an unverified body to pick its secret. */
export function selectDropCowboyWebhookSecret(
  rawBody: string,
  env: Record<string, string | undefined> = process.env,
): DropCowboySecretSelection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { kind: "unparseable" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unparseable" };
  const event = (parsed as Record<string, unknown>).event;
  if (typeof event !== "string") return { kind: "unparseable" };
  if (!Object.prototype.hasOwnProperty.call(DROPCOWBOY_EVENT_SECRET_ENV, event)) {
    return { kind: "unsupported", event };
  }
  const envName = DROPCOWBOY_EVENT_SECRET_ENV[event as DropCowboySignedEvent];
  const secret = env[envName] || null;
  return { kind: "supported", event: event as DropCowboySignedEvent, envName, secret };
}
