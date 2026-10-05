import type { NormaBlandConfig } from "./config";

/**
 * Bland AI client for the Norma pilot. The ONLY outbound network code for
 * Bland; `dispatchNormaCall` is the only caller of `sendCall`.
 *
 * Endpoints (docs.bland.ai): POST {base}/v1/calls, GET {base}/v1/calls/{id}.
 * Auth: `Authorization: Bearer <key>`.
 *
 * Responses are classified, never thrown:
 *  - accepted: 2xx with status "success" and a call_id.
 *  - rejected: explicit 4xx (no call created). 408 is excluded (ambiguous).
 *  - unknown:  timeout, network error, 5xx, 408, or a 2xx we cannot parse.
 */
export type BlandSendCallParams = {
  phoneNumber: string;
  requestId: string;
  idempotencyKey: string;
  /** Pathway variables, passed as Bland `request_data`. */
  variables: Record<string, string>;
};

export type BlandSendResult =
  | { kind: "accepted"; callId: string }
  | { kind: "rejected"; httpStatus: number; message: string }
  | { kind: "unknown"; reason: string };

/** Subset of Bland's get-call response that Sandra reads. */
export type BlandCall = {
  call_id?: string;
  to?: string;
  from?: string;
  status?: string;
  completed?: boolean;
  queue_status?: string;
  answered_by?: string | null;
  metadata?: Record<string, unknown> | null;
  variables?: Record<string, unknown> | null;
  analysis?: Record<string, unknown> | null;
  summary?: string | null;
  error_message?: string | null;
  [key: string]: unknown;
};

export type BlandLookupResult =
  | { kind: "found"; call: BlandCall }
  | { kind: "not_found" }
  | { kind: "unknown"; reason: string };

export type BlandClient = {
  sendCall(params: BlandSendCallParams): Promise<BlandSendResult>;
  getCall(callId: string): Promise<BlandLookupResult>;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_MESSAGE = 300;

function truncate(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_MESSAGE) : "";
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Build the exact send-call body. Exported for tests; contains no script text. */
export function buildSendCallBody(config: NormaBlandConfig, params: BlandSendCallParams) {
  return {
    phone_number: params.phoneNumber,
    pathway_id: config.pathwayId,
    pathway_version: config.pathwayVersion,
    voice: config.voice,
    from: config.fromNumber,
    metadata: { request_id: params.requestId, idempotency_key: params.idempotencyKey },
    webhook: config.webhookUrl,
    // Explicitly request audio for every outbound Norma call.
    record: true,
    // No voicemail message, no retry: a no-answer ends the attempt.
    voicemail: { action: "hangup" },
    request_data: params.variables,
    // Let the person say hello first; play office background instead of static.
    wait_for_greeting: config.waitForGreeting,
    background_track: config.backgroundTrack,
  };
}

export function createBlandClient(config: NormaBlandConfig, fetchImpl: FetchLike = fetch): BlandClient {
  async function request(method: "GET" | "POST", path: string, body?: unknown) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      return await fetchImpl(`${config.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async sendCall(params) {
      let response: Response;
      try {
        response = await request("POST", "/v1/calls", buildSendCallBody(config, params));
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        return { kind: "unknown", reason: aborted ? "timeout" : "network_error" };
      }
      const json = await readJson(response);
      if (response.status >= 200 && response.status < 300) {
        const callId = typeof json?.call_id === "string" ? json.call_id.trim() : "";
        if (json?.status === "success" && callId) return { kind: "accepted", callId };
        return { kind: "unknown", reason: "unparseable_success_response" };
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        return { kind: "rejected", httpStatus: response.status, message: truncate(json?.message) };
      }
      return { kind: "unknown", reason: `http_${response.status}` };
    },

    async getCall(callId) {
      let response: Response;
      try {
        response = await request("GET", `/v1/calls/${encodeURIComponent(callId)}`);
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        return { kind: "unknown", reason: aborted ? "timeout" : "network_error" };
      }
      if (response.status === 404) return { kind: "not_found" };
      const json = await readJson(response);
      if (response.status >= 200 && response.status < 300 && json) {
        return { kind: "found", call: json as BlandCall };
      }
      return { kind: "unknown", reason: `http_${response.status}` };
    },
  };
}
