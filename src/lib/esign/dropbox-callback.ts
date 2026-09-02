import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { ProviderSignature } from "./contracts";

const MAX_CALLBACK_JSON_BYTES = 1_000_000;
const MAX_PROVIDER_IDENTIFIER_LENGTH = 256;
const MAX_PROVIDER_SIGNATURES = 25;

export type DropboxSignReplayData = {
  payloadHash: string;
  eventTime: string;
  eventType: string;
  eventHash: string;
  signRequestId: string | null;
  localRequestId: string | null;
  testMode?: boolean | null;
  relatedSignatureId: string | null;
  reportedForAppId: string | null;
  providerSignatures: ProviderSignature[];
};

export type DropboxCallbackValidationCode =
  | "MISSING_JSON_FIELD"
  | "DUPLICATE_JSON_FIELD"
  | "INVALID_JSON_FIELD"
  | "CALLBACK_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_EVENT";

const SAFE_VALIDATION_MESSAGES: Record<DropboxCallbackValidationCode, string> = {
  MISSING_JSON_FIELD: "Dropbox Sign callback data is missing.",
  DUPLICATE_JSON_FIELD: "Dropbox Sign callback data is ambiguous.",
  INVALID_JSON_FIELD: "Dropbox Sign callback data is invalid.",
  CALLBACK_TOO_LARGE: "Dropbox Sign callback data exceeds the allowed size.",
  INVALID_JSON: "Dropbox Sign callback data is not valid JSON.",
  INVALID_EVENT: "Dropbox Sign callback event is invalid.",
};

export class DropboxCallbackValidationError extends Error {
  constructor(public readonly code: DropboxCallbackValidationCode) {
    super(SAFE_VALIDATION_MESSAGES[code]);
    this.name = "DropboxCallbackValidationError";
  }
}

export function parseDropboxSignCallbackFormData(
  formData: FormData,
): DropboxSignReplayData {
  const fields = formData.getAll("json");
  if (fields.length === 0) {
    throw new DropboxCallbackValidationError("MISSING_JSON_FIELD");
  }
  if (fields.length !== 1) {
    throw new DropboxCallbackValidationError("DUPLICATE_JSON_FIELD");
  }

  const rawJson = fields[0];
  if (typeof rawJson !== "string") {
    throw new DropboxCallbackValidationError("INVALID_JSON_FIELD");
  }
  if (new TextEncoder().encode(rawJson).byteLength > MAX_CALLBACK_JSON_BYTES) {
    throw new DropboxCallbackValidationError("CALLBACK_TOO_LARGE");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    throw new DropboxCallbackValidationError("INVALID_JSON");
  }
  return validateDropboxSignCallbackEvent(
    payload,
    createHash("sha256").update(rawJson, "utf8").digest("hex"),
  );
}

export function validateDropboxSignCallbackEvent(
  payload: unknown,
  payloadHash = createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex"),
): DropboxSignReplayData {
  if (!isRecord(payload) || !isRecord(payload.event)) {
    throw new DropboxCallbackValidationError("INVALID_EVENT");
  }

  const eventTime = parseEventTime(payload.event.event_time);
  const eventType = parseEventType(payload.event.event_type);
  const eventHash = parseEventHash(payload.event.event_hash);
  const signatureRequest = optionalRecord(payload.signature_request);
  const metadata = optionalRecord(payload.event.event_metadata);
  const requestMetadata = optionalRecord(signatureRequest?.metadata);
  const testMode = optionalBoolean(
    signatureRequest?.test_mode ?? signatureRequest?.testMode,
  );

  return {
    payloadHash,
    eventTime,
    eventType,
    eventHash,
    signRequestId: optionalIdentifier(signatureRequest?.signature_request_id),
    localRequestId: optionalIdentifier(requestMetadata?.sandra_request_id),
    ...(testMode === null ? {} : { testMode }),
    relatedSignatureId: optionalIdentifier(metadata?.related_signature_id),
    reportedForAppId: optionalIdentifier(metadata?.reported_for_app_id),
    providerSignatures: parseProviderSignatures(signatureRequest?.signatures),
  };
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function verifyDropboxSignEventHash(
  event: Pick<DropboxSignReplayData, "eventTime" | "eventType" | "eventHash">,
  apiKey: string,
): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(event.eventHash) || apiKey.length === 0) {
    return false;
  }

  const expected = createHmac("sha256", apiKey)
    .update(event.eventTime + event.eventType, "utf8")
    .digest();
  const received = Buffer.from(event.eventHash, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Dropbox Sign's event_hash authenticates event_time + event_type only. The
 * local fingerprint adds provider request and signer identity so same-second
 * events for different requests/signers are never collapsed.
 */
export function buildDropboxSignReceiptFingerprint(
  event: DropboxSignReplayData,
): string {
  const fields = [
    event.eventHash.toLowerCase(),
    event.eventTime,
    event.eventType,
    event.signRequestId,
    event.localRequestId,
    event.testMode == null ? null : String(event.testMode),
    event.relatedSignatureId,
    event.reportedForAppId,
  ];
  const hash = createHash("sha256");
  for (const field of fields) {
    if (field === null) {
      hash.update("-1:", "utf8");
    } else {
      hash.update(`${Buffer.byteLength(field, "utf8")}:`, "utf8");
      hash.update(field, "utf8");
    }
  }
  return hash.digest("hex");
}

function parseEventTime(value: unknown): string {
  if (typeof value === "number") {
    if (!validEventTime(value)) invalidEvent();
    return String(value);
  }
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) invalidEvent();
  if (!validEventTime(Number(value))) invalidEvent();
  return value;
}

function validEventTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 253_402_300_799;
}

function parseEventType(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,128}$/.test(value)) {
    invalidEvent();
  }
  return value;
}

function parseEventHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) {
    invalidEvent();
  }
  return value.toLowerCase();
}

function optionalIdentifier(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PROVIDER_IDENTIFIER_LENGTH
  ) {
    invalidEvent();
  }
  return value;
}

function parseProviderSignatures(value: unknown): ProviderSignature[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_SIGNATURES) {
    invalidEvent();
  }
  return value.map((item, index) => {
    if (!isRecord(item)) invalidEvent();
    const signatureId = optionalIdentifier(item.signature_id);
    const role = optionalIdentifier(item.signer_role);
    const name = optionalIdentifier(item.signer_name);
    const emailAddress = optionalIdentifier(item.signer_email_address);
    if (!signatureId || !role || !name || !emailAddress) invalidEvent();
    const order = optionalOrder(item.order, index);
    return {
      signatureId,
      role,
      name,
      emailAddress,
      order,
      statusCode: optionalIdentifier(item.status_code),
      signedAt: optionalTimestamp(item.signed_at),
    };
  });
}

function optionalOrder(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidEvent();
  }
  return value;
}

function optionalTimestamp(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidEvent();
  }
  return value;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalidEvent();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidEvent(): never {
  throw new DropboxCallbackValidationError("INVALID_EVENT");
}
