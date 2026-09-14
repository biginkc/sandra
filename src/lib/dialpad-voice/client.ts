import "server-only";

const API_BASE = "https://dialpad.com/api/v2";
export type DialpadVoiceObject = Record<string, unknown>;
export type DialpadVoiceErrorCode = "configuration" | "invalid_input" | "transport" | "http" | "response";

/** Sanitized: never includes provider bodies, request URLs, or credentials. */
export class DialpadVoiceError extends Error {
  constructor(readonly code: DialpadVoiceErrorCode, readonly status?: number) {
    super(`Dialpad voice ${code}${status === undefined ? "" : ` (${status})`}`);
    this.name = "DialpadVoiceError";
  }
}

function id(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) throw new DialpadVoiceError("invalid_input");
  return value;
}

function numericId(value: string): number {
  const number = Number(id(value));
  if (!Number.isSafeInteger(number)) throw new DialpadVoiceError("invalid_input");
  return number;
}

function phone(value: string): string {
  if (!/^\+[1-9]\d{1,14}$/.test(value)) throw new DialpadVoiceError("invalid_input");
  return value;
}

/** Low-level transport only. Callers must authorize lead, rep, call ownership and
 * rate limits. Never automatically retries a mutation with an uncertain outcome.
 * Response objects stay untrusted until normalized; docs omit complete schemas.
 */
export class DialpadVoiceClient {
  #apiKey: string;
  #fetch: typeof fetch;
  #timeoutMs: number;

  constructor(apiKey: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    if (!apiKey.trim() || /[\r\n]/.test(apiKey)) throw new DialpadVoiceError("configuration");
    this.#apiKey = apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 60_000) {
      throw new DialpadVoiceError("configuration");
    }
  }

  listUserDevices(userId: string, cursor?: string) {
    return this.request("GET", "/userdevices", { user_id: id(userId), ...(cursor ? { cursor } : {}) });
  }

  getCallerId(userId: string) {
    return this.request("GET", `/users/${id(userId)}/caller_id`);
  }

  getUser(userId: string) {
    return this.request("GET", `/users/${id(userId)}`);
  }

  getCall(callId: string) {
    return this.request("GET", `/call/${id(callId)}`);
  }

  listCalls(userId: string, options: { cursor?: string; startedAfter?: number; startedBefore?: number } = {}) {
    const query: Record<string, string> = { target_type: "user", target_id: id(userId) };
    for (const [key, value] of [["started_after", options.startedAfter], ["started_before", options.startedBefore]] as const) {
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 0) throw new DialpadVoiceError("invalid_input");
        query[key] = String(value);
      }
    }
    if (options.startedAfter !== undefined && options.startedBefore !== undefined && options.startedAfter >= options.startedBefore) {
      throw new DialpadVoiceError("invalid_input");
    }
    if (options.cursor) query.cursor = options.cursor;
    return this.request("GET", "/call", query);
  }

  initiateSelectedDeviceCall(input: { userId: string; deviceId: string; phoneNumber: string; outboundCallerId: string; customData: string; group?: { id: string; type: "office" | "department" | "callcenter" } }) {
    if (!input.deviceId.trim() || input.deviceId.length > 512 || !input.customData.trim() || input.customData.length > 2000) {
      throw new DialpadVoiceError("invalid_input");
    }
    // Group ownership is resolved from the server's authorized number grant.
    // A selected shared caller ID must not silently inherit another group.
    if (input.group && !["office", "department", "callcenter"].includes(input.group.type)) {
      throw new DialpadVoiceError("invalid_input");
    }
    return this.request("POST", "/call", undefined, {
      user_id: numericId(input.userId), device_id: input.deviceId,
      phone_number: phone(input.phoneNumber), outbound_caller_id: phone(input.outboundCallerId),
      custom_data: input.customData, is_consult: false,
      ...(input.group ? { group_id: numericId(input.group.id), group_type: input.group.type } : {}),
    });
  }

  hangupCall(callId: string) {
    return this.request("PUT", `/call/${id(callId)}/actions/hangup`);
  }

  private async request(method: string, path: string, query?: Record<string, string>, body?: DialpadVoiceObject): Promise<DialpadVoiceObject> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method, redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new DialpadVoiceError("http", response.status);
      // Read body within the same timeout as response headers.
      const text = await response.text();
      if (!text.trim() && method === "PUT") return {};
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new DialpadVoiceError("response");
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new DialpadVoiceError("response"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new DialpadVoiceError("response");
      return value as DialpadVoiceObject;
    } catch (error) {
      if (error instanceof DialpadVoiceError) throw error;
      throw new DialpadVoiceError("transport");
    } finally {
      clearTimeout(timeout);
    }
  }
}
