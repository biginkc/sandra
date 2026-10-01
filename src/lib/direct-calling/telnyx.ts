import "server-only";

import type { TelnyxDirectSettings } from "./config";

const TELNYX_API = "https://api.telnyx.com/v2";
const TIMEOUT_MS = 10_000;

/**
 * kind "rejected": Telnyx answered with a 4xx, so the command definitely did not run.
 * kind "unknown": timeout, network failure or 5xx - the command may or may not have run.
 */
export class TelnyxApiError extends Error {
  constructor(
    message: string,
    readonly kind: "rejected" | "unknown",
    readonly status: number | null,
    readonly details: { code?: string | null; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = "TelnyxApiError";
  }

  /** Telnyx error code of the first error in the response body (e.g. "90018"). */
  get code(): string | null {
    return this.details.code ?? null;
  }

  /** Server-requested wait (Retry-After), if any. */
  get retryAfterMs(): number | null {
    return this.details.retryAfterMs ?? null;
  }
}

type Fetch = typeof fetch;

export type TelnyxClientOptions = { fetchImpl?: Fetch; timeoutMs?: number };

function redact(text: string, apiKey: string): string {
  let out = text.split(apiKey).join("[redacted]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  return out.slice(0, 300);
}

async function request(
  settings: Pick<TelnyxDirectSettings, "apiKey">,
  method: "POST" | "GET",
  path: string,
  body: unknown,
  accept: "json" | "text",
  options: TelnyxClientOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  // The timeout stays armed until the body is fully read, so a stalled body cannot hang the caller.
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${TELNYX_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
          Accept: accept === "json" ? "application/json" : "text/plain",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new TelnyxApiError(aborted ? "Telnyx request timed out." : "Telnyx request failed.", "unknown", null);
    }
    let text = "";
    try {
      text = await response.text();
    } catch (error) {
      // A 2xx whose body never arrived may still have run the command.
      if (response.ok) {
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new TelnyxApiError(aborted ? "Telnyx request timed out." : "Telnyx response could not be read.", "unknown", null);
      }
    }
    if (!response.ok) {
      let detail = "";
      let code: string | null = null;
      try {
        const parsed = JSON.parse(text) as { errors?: Array<{ code?: unknown; title?: string; detail?: string }> };
        detail = parsed.errors?.map((e) => e.detail ?? e.title ?? "").filter(Boolean).join("; ") ?? "";
        const first = parsed.errors?.[0]?.code;
        code = typeof first === "string" || typeof first === "number" ? String(first) : null;
      } catch {
        // not JSON
      }
      const retryAfterSecs = Number(response.headers?.get?.("retry-after"));
      const kind = response.status >= 500 ? "unknown" : "rejected";
      throw new TelnyxApiError(
        `Telnyx ${path.replace(/\/[0-9a-f-]{8,}/gi, "/:id")} returned ${response.status}${detail ? `: ${redact(detail, settings.apiKey)}` : ""}`,
        kind,
        response.status,
        { code, retryAfterMs: Number.isFinite(retryAfterSecs) && retryAfterSecs > 0 ? Math.min(retryAfterSecs, 300) * 1000 : null },
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Telnyx error code for "Call has already ended" on a hangup (OpenAPI HangupCall: 422 / 90018). */
export const CALL_ALREADY_ENDED_CODE = "90018";

/**
 * True only for the documented already-ended refusal: 422 with code 90018. Any other 4xx (including
 * an undocumented 404) is NOT a confirmation; the leg stays pending until a hangup webhook or a status
 * check (is_alive:false) agrees.
 */
export function isLegAlreadyEnded(error: unknown): boolean {
  return error instanceof TelnyxApiError && error.kind === "rejected" && error.status === 422 && error.code === CALL_ALREADY_ENDED_CODE;
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TelnyxApiError("Telnyx returned an unreadable response.", "unknown", null);
  }
}

export type DialParams = {
  to: string;
  from: string;
  clientState: Record<string, string>;
  commandId: string;
  timeoutSecs: number;
  timeLimitSecs: number;
  customHeaders?: Array<{ name: string; value: string }>;
  linkTo?: string;
  bridgeOnAnswer?: boolean;
  bridgeIntent?: boolean;
};

export function encodeClientState(state: Record<string, string>): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

export function decodeClientState(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function telnyxDial(
  settings: TelnyxDirectSettings,
  params: DialParams,
  options: TelnyxClientOptions = {},
): Promise<{ callControlId: string }> {
  const body: Record<string, unknown> = {
    connection_id: settings.appId,
    to: params.to,
    from: params.from,
    client_state: encodeClientState(params.clientState),
    command_id: params.commandId,
    timeout_secs: params.timeoutSecs,
    time_limit_secs: params.timeLimitSecs,
  };
  if (params.customHeaders) body.custom_headers = params.customHeaders;
  if (params.linkTo) body.link_to = params.linkTo;
  if (params.bridgeOnAnswer !== undefined) body.bridge_on_answer = params.bridgeOnAnswer;
  if (params.bridgeIntent !== undefined) body.bridge_intent = params.bridgeIntent;
  const text = await request(settings, "POST", "/calls", body, "json", options);
  const id = parseJson<{ data?: { call_control_id?: string } }>(text).data?.call_control_id;
  if (!id) throw new TelnyxApiError("Telnyx dial response had no call_control_id.", "unknown", null);
  return { callControlId: id };
}

export async function telnyxHangup(
  settings: TelnyxDirectSettings,
  callControlId: string,
  commandId: string,
  options: TelnyxClientOptions = {},
): Promise<void> {
  await request(
    settings,
    "POST",
    `/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
    { command_id: commandId },
    "json",
    options,
  );
}

/**
 * GET /v2/calls/{call_control_id} ("Retrieve a call status"; data.is_alive; available for 10 minutes
 * after the call ended). Only an explicit is_alive:false is "gone": any error (including an expired or
 * unknown id) is not a confirmation and throws.
 */
export async function telnyxGetCallAlive(
  settings: Pick<TelnyxDirectSettings, "apiKey">,
  callControlId: string,
  options: TelnyxClientOptions = {},
): Promise<{ isAlive: boolean }> {
  const text = await request(settings, "GET", `/calls/${encodeURIComponent(callControlId)}`, undefined, "json", options);
  const alive = parseJson<{ data?: { is_alive?: unknown } }>(text).data?.is_alive;
  // Anything but an explicit false is "still alive": never confirm a teardown on ambiguity.
  return { isAlive: alive !== false };
}

export type ActiveCall = { callControlId: string; clientState: Record<string, unknown> | null };

const ACTIVE_CALLS_PAGE = 250;
const ACTIVE_CALLS_MAX_PAGES = 4;

/**
 * GET /v2/connections/{connection_id}/active_calls (Telnyx OpenAPI: "List all active calls for given
 * connection"; cursor pagination via page[limit] and meta.cursors.after; each item carries
 * call_control_id and the base64 client_state we sent). The connection is the Voice API app the
 * server Dials on. `complete:false` means the listing was cut short: an absence of matches in it
 * proves nothing.
 */
export async function telnyxListActiveCalls(
  settings: Pick<TelnyxDirectSettings, "apiKey" | "appId">,
  options: TelnyxClientOptions = {},
): Promise<{ calls: ActiveCall[]; complete: boolean }> {
  const calls: ActiveCall[] = [];
  let after: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < ACTIVE_CALLS_MAX_PAGES; page += 1) {
    const query = `page%5Blimit%5D=${ACTIVE_CALLS_PAGE}${after ? `&page%5Bafter%5D=${encodeURIComponent(after)}` : ""}`;
    const text = await request(settings, "GET", `/connections/${encodeURIComponent(settings.appId)}/active_calls?${query}`, undefined, "json", options);
    const parsed: { data?: Array<{ call_control_id?: unknown; client_state?: unknown }>; meta?: { cursors?: { after?: unknown } } } = parseJson(text);
    if (!Array.isArray(parsed.data)) throw new TelnyxApiError("Telnyx returned an unreadable response.", "unknown", null);
    for (const item of parsed.data) {
      if (typeof item.call_control_id === "string" && item.call_control_id) {
        calls.push({ callControlId: item.call_control_id, clientState: decodeClientState(item.client_state) });
      }
    }
    const next: unknown = parsed.meta?.cursors?.after;
    // Follow the cursor whatever the page length (an empty page can still have a next page); only an
    // absent cursor ends the listing. A repeated cursor can never finish, so it is incomplete.
    if (typeof next !== "string" || !next) return { calls, complete: true };
    if (seen.has(next)) return { calls, complete: false };
    seen.add(next);
    after = next;
  }
  return { calls, complete: false };
}

export async function telnyxSendDtmf(
  settings: TelnyxDirectSettings,
  callControlId: string,
  digit: string,
  options: TelnyxClientOptions = {},
): Promise<void> {
  await request(
    settings,
    "POST",
    `/calls/${encodeURIComponent(callControlId)}/actions/send_dtmf`,
    { digits: digit },
    "json",
    options,
  );
}

export async function telnyxCreateCredential(
  settings: TelnyxDirectSettings,
  name: string,
  options: TelnyxClientOptions = {},
): Promise<{ id: string; sipUsername: string }> {
  const text = await request(
    settings,
    "POST",
    "/telephony_credentials",
    { connection_id: settings.connectionId, name },
    "json",
    options,
  );
  const data = parseJson<{ data?: { id?: string; sip_username?: string } }>(text).data;
  if (!data?.id || !data.sip_username) throw new TelnyxApiError("Telnyx credential response was incomplete.", "unknown", null);
  return { id: data.id, sipUsername: data.sip_username };
}

/** Returns the WebRTC login JWT (the endpoint responds with text/plain). */
export async function telnyxCreateToken(
  settings: TelnyxDirectSettings,
  credentialId: string,
  options: TelnyxClientOptions = {},
): Promise<string> {
  const text = (await request(settings, "POST", `/telephony_credentials/${encodeURIComponent(credentialId)}/token`, undefined, "text", options)).trim();
  if (!text) throw new TelnyxApiError("Telnyx returned an empty token.", "unknown", null);
  return text;
}
