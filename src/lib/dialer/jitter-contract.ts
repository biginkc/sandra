import { createHmac } from "node:crypto";

const JITTER_REQUEST_TIMEOUT_MS = 15_000;

export const JITTER_SOFTPHONE_PATHS = {
  startCall: "/api/internal/sandra/softphone/start-call",
  token: "/api/internal/sandra/softphone/token",
  connect: "/api/internal/sandra/softphone/connect",
  cancel: "/api/internal/sandra/softphone/cancel",
} as const;

export type JitterStartCallRequest = {
  operatorEmail: string;
  phoneE164: string;
  propertyRef?: string;
  contactRef?: string;
};

export type JitterStartCallResponse = {
  sessionRef: string;
  batchId: string;
};

export type JitterTokenResponse = {
  rtcToken: string;
  sipIdentity: string;
  expiresAt: string;
};

export type JitterCancelReason = "hangup" | "failed" | "abandoned";

export type JitterProxyError = {
  ok: false;
  status: number;
  error: string;
  errorCode: string;
  reason?: string;
};

export type JitterProxyResult<T> = { ok: true; data: T } | JitterProxyError;

type JsonObject = Record<string, unknown>;
type ResponseValidator<T> = (value: unknown) => value is T;

function configuredJitter(): { baseUrl: string; serviceToken: string } | JitterProxyError {
  const baseUrl = process.env.JITTER_SOFTPHONE_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
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
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback && process.env.NODE_ENV !== "production")) {
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

export function signJitterSoftphoneBody(serviceToken: string, rawBody = ""): string {
  return `sha256=${createHmac("sha256", serviceToken).update(rawBody).digest("hex")}`;
}

export async function requestJitterSoftphone<T>(args: {
  path: string;
  body?: JsonObject;
  validate: ResponseValidator<T>;
  fetchImpl?: typeof fetch;
}): Promise<JitterProxyResult<T>> {
  const config = configuredJitter();
  if ("ok" in config) return config;

  const rawBody = args.body === undefined ? "" : JSON.stringify(args.body);
  let response: Response;
  try {
    response = await (args.fetchImpl ?? fetch)(`${config.baseUrl}${args.path}`, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(JITTER_REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${config.serviceToken}`,
        "x-sandra-signature": signJitterSoftphoneBody(config.serviceToken, rawBody),
        ...(rawBody ? { "content-type": "application/json" } : {}),
      },
      ...(rawBody ? { body: rawBody } : {}),
    });
  } catch {
    return {
      ok: false,
      status: 503,
      error: "Jitter softphone is unavailable.",
      errorCode: "jitter_unavailable",
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
      error: stringValue(envelope.error) ?? `Jitter softphone request failed (${response.status}).`,
      errorCode: stringValue(envelope.error_code) ?? "jitter_request_failed",
      ...(stringValue(envelope.reason) ? { reason: stringValue(envelope.reason) } : {}),
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

export function requestJitterStartCall(
  body: JitterStartCallRequest,
  fetchImpl?: typeof fetch,
): Promise<JitterProxyResult<JitterStartCallResponse>> {
  return requestJitterSoftphone({ path: JITTER_SOFTPHONE_PATHS.startCall, body, validate: isStartResponse, fetchImpl });
}

export function requestJitterToken(
  sessionRef: string,
  fetchImpl?: typeof fetch,
): Promise<JitterProxyResult<JitterTokenResponse>> {
  return requestJitterSoftphone({ path: JITTER_SOFTPHONE_PATHS.token, body: { sessionRef }, validate: isTokenResponse, fetchImpl });
}

export function requestJitterConnect(
  sessionRef: string,
  fetchImpl?: typeof fetch,
): Promise<JitterProxyResult<{ dialing: true }>> {
  return requestJitterSoftphone({ path: JITTER_SOFTPHONE_PATHS.connect, body: { sessionRef }, validate: isConnectResponse, fetchImpl });
}

export function requestJitterCancel(
  sessionRef: string,
  reason: JitterCancelReason,
  fetchImpl?: typeof fetch,
): Promise<JitterProxyResult<{ tornDown: true }>> {
  return requestJitterSoftphone({ path: JITTER_SOFTPHONE_PATHS.cancel, body: { sessionRef, reason }, validate: isCancelResponse, fetchImpl });
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isStartResponse(value: unknown): value is JitterStartCallResponse {
  return isObject(value) && Boolean(stringValue(value.sessionRef) && stringValue(value.batchId));
}

function isTokenResponse(value: unknown): value is JitterTokenResponse {
  return isObject(value)
    && Boolean(stringValue(value.rtcToken) && stringValue(value.sipIdentity) && stringValue(value.expiresAt))
    && Number.isFinite(Date.parse(String(value.expiresAt)));
}

function isConnectResponse(value: unknown): value is { dialing: true } {
  return isObject(value) && value.dialing === true;
}

function isCancelResponse(value: unknown): value is { tornDown: true } {
  return isObject(value) && value.tornDown === true;
}
