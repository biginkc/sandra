import { createHmac } from "node:crypto";

const JITTER_REQUEST_TIMEOUT_MS = 15_000;
const JITTER_START_ATTEMPTS = 2;

export const JITTER_SOFTPHONE_PATHS = {
  callerIds: "/api/internal/sandra/softphone/caller-ids",
  startCall: "/api/internal/sandra/softphone/start-call",
  token: "/api/internal/sandra/softphone/token",
  connect: "/api/internal/sandra/softphone/connect",
  audioHealth: "/api/internal/sandra/softphone/audio-health",
  digit: "/api/internal/sandra/softphone/digit",
  cancel: "/api/internal/sandra/softphone/cancel",
} as const;

export type JitterStartCallRequest = {
  operator_id: string;
  phone_e164: string;
  timezone: string;
  caller_id_e164: string;
  /** Sandra-owned IDs, copied from the server-prepared eligible target. */
  property_ref?: string;
  contact_ref?: string;
  /** Sandra's authenticated tenant identity, when available. */
  org_ref?: string;
};

export type JitterCallerId = {
  phone_e164: string;
  label: string;
};

export type JitterCallerIdsResponse = { caller_ids: JitterCallerId[] };

export type JitterStartCallResponse = {
  call_id: string;
  session_id: string;
  batch_id: string;
  run_id: string;
};

export type JitterTokenResponse = {
  rtc_token: string;
  sip_identity: string;
  expires_at: string;
};

export type JitterConnectPhase = "registered" | "accepted";
export type JitterCancelReason = "hangup" | "failed" | "abandoned";

export type JitterAudioHealthSample = {
  controller_id: string;
  peer_connection_generation: number;
  sample_sequence: number;
  packets_received: number;
  bytes_received: number;
};

export type JitterAudioHealthResponse = {
  accepted: boolean;
  pending?: boolean;
  status?: "monitoring" | "healthy" | "suspect";
};

export type JitterCancelResponse = {
  call_id: string;
  session_id: string;
  status: "ended" | "failed";
  teardown: {
    released_batch_claims: number;
    revoked_bindings: number;
    revoked_device_leases: number;
    ended_shifts: number;
    released_worker_leases: number;
  };
};

export type JitterProxyError = {
  ok: false;
  status: number;
  error: string;
  errorCode: string;
  reason?: string;
  /** Set only when a start request may have committed before its response was lost. */
  ambiguous?: boolean;
};

export type JitterProxyResult<T> = { ok: true; data: T } | JitterProxyError;

/**
 * `ambiguous` is deliberately independent from HTTP status: a delivered 500
 * and a lost response can both mean Jitter provisioned. Any delivered 4xx is
 * authoritative and clears the fallback.
 */
export type JitterStartCallResult = JitterProxyResult<{
  callId: string;
  batchId: string;
}> & {
  ambiguous?: boolean;
};

type JsonObject = Record<string, unknown>;
type ResponseValidator<T> = (value: unknown) => value is T;

function configuredJitter():
  { baseUrl: string; serviceToken: string } | JitterProxyError {
  const baseUrl =
    process.env.JITTER_SOFTPHONE_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  const serviceToken = process.env.JITTER_SOFTPHONE_SERVICE_TOKEN?.trim() ?? "";
  if (!baseUrl || !serviceToken) {
    return {
      ok: false,
      status: 503,
      error: "Jitter softphone is not configured.",
      errorCode: "jitter_not_configured",
    };
  }
  try {
    const parsed = new URL(baseUrl);
    const loopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1";
    if (
      parsed.protocol !== "https:" &&
      !(
        parsed.protocol === "http:" &&
        loopback &&
        process.env.NODE_ENV !== "production"
      )
    ) {
      throw new Error("Jitter softphone requires HTTPS");
    }
  } catch {
    return {
      ok: false,
      status: 503,
      error: "Jitter softphone base URL is invalid.",
      errorCode: "jitter_invalid_configuration",
    };
  }
  return { baseUrl, serviceToken };
}

export function signJitterSoftphoneBody(
  serviceToken: string,
  rawBody = "",
): string {
  return `sha256=${createHmac("sha256", serviceToken).update(rawBody).digest("hex")}`;
}

export async function requestJitterSoftphone<T>(args: {
  path: string;
  method?: "GET" | "POST";
  body?: JsonObject;
  idempotencyKey?: string;
  ambiguousOnNetworkError?: boolean;
  validate: ResponseValidator<T>;
  fetchImpl?: typeof fetch;
}): Promise<JitterProxyResult<T>> {
  const config = configuredJitter();
  if ("ok" in config) return config;

  const method = args.method ?? "POST";
  const rawBody = args.body === undefined ? "" : JSON.stringify(args.body);
  let response: Response;
  try {
    response = await (args.fetchImpl ?? fetch)(
      `${config.baseUrl}${args.path}`,
      {
        method,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(JITTER_REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${config.serviceToken}`,
          "X-Jitter-Signature": signJitterSoftphoneBody(
            config.serviceToken,
            rawBody,
          ),
          ...(args.idempotencyKey
            ? { "Idempotency-Key": args.idempotencyKey }
            : {}),
          ...(rawBody ? { "content-type": "application/json" } : {}),
        },
        ...(rawBody ? { body: rawBody } : {}),
      },
    );
  } catch {
    return {
      ok: false,
      status: 503,
      error: "Jitter softphone is unavailable.",
      errorCode: "jitter_unavailable",
      ...(args.ambiguousOnNetworkError ? { ambiguous: true } : {}),
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const envelope = isObject(payload) ? payload : {};
    return {
      ok: false,
      status: response.status,
      error:
        stringValue(envelope.error) ??
        `Jitter softphone request failed (${response.status}).`,
      errorCode: stringValue(envelope.error_code) ?? "jitter_request_failed",
    };
  }

  if (!args.validate(payload)) {
    return {
      ok: false,
      status: 502,
      error: "Jitter softphone returned an invalid response.",
      errorCode: "jitter_contract_violation",
    };
  }
  return { ok: true, data: payload };
}

export async function requestJitterStartCall(
  body: JitterStartCallRequest,
  idempotencyKey: string,
  fetchImpl?: typeof fetch,
): Promise<JitterProxyResult<JitterStartCallResponse>> {
  let result: JitterProxyResult<JitterStartCallResponse> | undefined;
  for (let attempt = 0; attempt < JITTER_START_ATTEMPTS; attempt += 1) {
    result = await requestJitterSoftphone({
      path: JITTER_SOFTPHONE_PATHS.startCall,
      body,
      idempotencyKey,
      ambiguousOnNetworkError: true,
      validate: isStartResponse,
      fetchImpl,
    });
    if (result.ok || !isRetryableStartFailure(result)) return result;
  }
  return result!;
}

export function requestJitterCallerIds(
  fetchImpl?: typeof fetch,
): Promise<JitterProxyResult<JitterCallerIdsResponse>> {
  return requestJitterSoftphone({
    path: JITTER_SOFTPHONE_PATHS.callerIds,
    method: "GET",
    validate: isCallerIdsResponse,
    fetchImpl,
  });
}

export function requestJitterToken(
  callId: string,
  fetchImpl?: typeof fetch,
): Promise<JitterProxyResult<JitterTokenResponse>> {
  const path = `${JITTER_SOFTPHONE_PATHS.token}?call_id=${encodeURIComponent(callId)}`;
  return requestJitterSoftphone({
    path,
    method: "GET",
    validate: isTokenResponse,
    fetchImpl,
  });
}

export function requestJitterConnect(
  callId: string,
  phase: JitterConnectPhase,
  fetchImpl?: typeof fetch,
): Promise<JitterProxyResult<{ dialing: true }>> {
  return requestJitterSoftphone({
    path: JITTER_SOFTPHONE_PATHS.connect,
    body: { call_id: callId, phase },
    validate: isConnectResponse,
    fetchImpl,
  });
}

export function requestJitterCancel(
  callId: string,
  reason: JitterCancelReason,
  fetchImpl?: typeof fetch,
): Promise<JitterProxyResult<JitterCancelResponse>> {
  return requestJitterSoftphone({
    path: JITTER_SOFTPHONE_PATHS.cancel,
    body: { call_id: callId, reason },
    validate: isCancelResponse,
    fetchImpl,
  });
}

export function requestJitterCancelByIdempotencyKey(
  idempotencyKey: string,
  reason: JitterCancelReason,
  fetchImpl?: typeof fetch,
): Promise<JitterProxyResult<JitterCancelResponse>> {
  return requestJitterSoftphone({
    path: JITTER_SOFTPHONE_PATHS.cancel,
    body: { idempotency_key: idempotencyKey, reason },
    validate: isCancelResponse,
    fetchImpl,
  });
}

export function requestJitterAudioHealth(
  callId: string,
  sample: JitterAudioHealthSample,
  fetchImpl?: typeof fetch,
): Promise<JitterProxyResult<JitterAudioHealthResponse>> {
  return requestJitterSoftphone({
    path: JITTER_SOFTPHONE_PATHS.audioHealth,
    body: { call_id: callId, ...sample },
    validate: isAudioHealthResponse,
    fetchImpl,
  });
}

export function requestJitterDigit(
  callId: string,
  digit: string,
  fetchImpl?: typeof fetch,
): Promise<JitterProxyResult<{ sent: true }>> {
  return requestJitterSoftphone({
    path: JITTER_SOFTPHONE_PATHS.digit,
    body: { call_id: callId, digit },
    validate: (value): value is { sent: true } => isObject(value) && value.sent === true,
    fetchImpl,
  });
}

function isRetryableStartFailure(error: JitterProxyError): boolean {
  return (
    error.status >= 500 &&
    error.errorCode !== "jitter_not_configured" &&
    error.errorCode !== "jitter_invalid_configuration"
  );
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isStartResponse(value: unknown): value is JitterStartCallResponse {
  return (
    isObject(value) &&
    Boolean(
      stringValue(value.call_id) &&
      stringValue(value.session_id) &&
      stringValue(value.batch_id) &&
      stringValue(value.run_id),
    )
  );
}

function isCallerIdsResponse(value: unknown): value is JitterCallerIdsResponse {
  if (!isObject(value) || !Array.isArray(value.caller_ids))
    return false;
  return value.caller_ids.every(
    (callerId) =>
      isObject(callerId) &&
      typeof callerId.phone_e164 === "string" &&
      /^\+[1-9]\d{7,14}$/.test(callerId.phone_e164) &&
      typeof callerId.label === "string" &&
      Boolean(stringValue(callerId.label)) &&
      callerId.label.length <= 100 &&
      Object.keys(callerId).every((key) => key === "phone_e164" || key === "label"),
  );
}

function isTokenResponse(value: unknown): value is JitterTokenResponse {
  return (
    isObject(value) &&
    Boolean(
      stringValue(value.rtc_token) &&
      stringValue(value.sip_identity) &&
      stringValue(value.expires_at),
    ) &&
    Number.isFinite(Date.parse(String(value.expires_at)))
  );
}

function isConnectResponse(value: unknown): value is { dialing: true } {
  return isObject(value) && value.dialing === true;
}

function isAudioHealthResponse(
  value: unknown,
): value is JitterAudioHealthResponse {
  if (!isObject(value) || typeof value.accepted !== "boolean") return false;
  if (value.pending !== undefined && typeof value.pending !== "boolean")
    return false;
  return (
    value.status === undefined ||
    value.status === "monitoring" ||
    value.status === "healthy" ||
    value.status === "suspect"
  );
}

function isCancelResponse(value: unknown): value is JitterCancelResponse {
  if (!isObject(value) || !isObject(value.teardown)) return false;
  return (
    Boolean(stringValue(value.call_id) && stringValue(value.session_id)) &&
    (value.status === "ended" || value.status === "failed") &&
    [
      value.teardown.released_batch_claims,
      value.teardown.revoked_bindings,
      value.teardown.revoked_device_leases,
      value.teardown.ended_shifts,
      value.teardown.released_worker_leases,
    ].every(
      (count) =>
        typeof count === "number" && Number.isInteger(count) && count >= 0,
    )
  );
}
