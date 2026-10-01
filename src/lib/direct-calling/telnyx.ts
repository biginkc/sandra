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
  ) {
    super(message);
    this.name = "TelnyxApiError";
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
  method: "POST",
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
      try {
        const parsed = JSON.parse(text) as { errors?: Array<{ title?: string; detail?: string }> };
        detail = parsed.errors?.map((e) => e.detail ?? e.title ?? "").filter(Boolean).join("; ") ?? "";
      } catch {
        // not JSON
      }
      const kind = response.status >= 500 ? "unknown" : "rejected";
      throw new TelnyxApiError(
        `Telnyx ${path.replace(/\/[0-9a-f-]{8,}/gi, "/:id")} returned ${response.status}${detail ? `: ${redact(detail, settings.apiKey)}` : ""}`,
        kind,
        response.status,
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** True when a hangup was refused because the leg is already gone (404 / "already ended"). */
export function isLegAlreadyEnded(error: unknown): boolean {
  if (!(error instanceof TelnyxApiError) || error.kind !== "rejected") return false;
  if (error.status === 404) return true;
  return error.status === 422 && /already|ended|no longer|not found|does not exist/i.test(error.message);
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
