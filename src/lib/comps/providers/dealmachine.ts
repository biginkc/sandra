import "server-only";


/**
 * DealMachine estimated-value lookup (routing v2 PR-E, BUILD-PLAN §15).
 *
 * `POST /v1/enrichment/address` per DealMachine's API reference
 * (https://api.docs.dealmachine.com/api-reference/enrichment/enrich-by-address):
 *   request  `{ data: [{ street, city, state, zip? }], fields: ["estimated_value"], contact_audience: "none" }`
 *            with `Authorization: Bearer <key>`;
 *   response `{ data: [{ matched, estimated_value, match_failure? }], totals, credits: { used } }`.
 * `contact_audience: "none"` skips people/contacts (fewer credits). Each request costs
 * credits, so every HTTP attempt first goes through `beforeAttempt` (the caller writes the
 * spend-ledger row and takes a slot in the shared per-org rate limit; no slot or a failed write
 * = no request), then `onAttempt` settles that row.
 *
 * Retries: at most 2 on 429 / 5xx / timeout / network error, exponential with jitter, honoring
 * `Retry-After` when it is short enough to wait inline; otherwise the caller gets a retryable
 * result with the retry delay to store as backoff. 10 s per-request timeout. The key is never
 * logged.
 */
export const DEALMACHINE_BASE_URL = "https://api.v2.dealmachine.com";
export const DEALMACHINE_ENRICH_ADDRESS_PATH = "/v1/enrichment/address";
export const DEALMACHINE_TIMEOUT_MS = 10_000;
export const DEALMACHINE_MAX_RETRIES = 2;
/** Longest Retry-After we wait inline; longer goes back to the caller as backoff. */
export const DEALMACHINE_MAX_INLINE_WAIT_MS = 5_000;

export type DealMachineAddress = { street: string; city: string; state: string; zip?: string | null };

export type DealMachineAttempt = {
  callId: string;
  /** HTTP status, or null for a timeout/network error (no response). */
  httpStatus: number | null;
  /** `credits.used` when the response reported it; null otherwise. */
  creditsUsed: number | null;
};

export type DealMachineValueResult =
  | { kind: "ok"; value: number }
  /** Address not matched, or matched with no usable value (null / 0 / not a number). */
  | { kind: "no_value"; reason: string }
  /** 429 / 5xx / timeout / network, retries exhausted. */
  | { kind: "retryable_error"; reason: string; retryAfterSeconds: number }
  /** 400 / 401 / other non-retryable response or an unreadable body. */
  | { kind: "error"; reason: string }
  /** The shared rate limit had no slot: no request was sent. */
  | { kind: "rate_limited" }
  /** The pre-call ledger write failed: no request was sent (fail closed). */
  | { kind: "accounting_failed" };

export type DealMachineOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /**
   * REQUIRED (cutover TODO d): called before EVERY HTTP request. Returns the ledger call id, or
   * null when the shared rate limit is full. Throwing = the ledger write failed. Either way no
   * request is sent. There is no un-ledgered path to the provider.
   */
  beforeAttempt: () => Promise<string | null>;
  /** REQUIRED: settles the ledger row for every attempt that was sent. */
  onAttempt: (attempt: DealMachineAttempt) => Promise<void> | void;
};

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export function buildDealMachineEnrichRequest(address: DealMachineAddress): Json {
  const item: Json = { street: address.street.trim(), city: address.city.trim(), state: address.state.trim() };
  const zip = address.zip?.trim();
  if (zip) item.zip = zip;
  return { data: [item], fields: ["estimated_value"], contact_audience: "none" };
}

/** Reads `data[0]`: matched + a positive finite `estimated_value` → ok; anything else → no_value. */
export function parseDealMachineEnrichResponse(body: unknown): DealMachineValueResult {
  if (!isRecord(body) || !Array.isArray(body.data)) return { kind: "error", reason: "invalid_response" };
  const item = body.data[0];
  if (!isRecord(item)) return { kind: "no_value", reason: "no_item" };
  if (item.matched !== true) {
    const code = isRecord(item.match_failure) && typeof item.match_failure.code === "string" ? item.match_failure.code : "unmatched";
    return { kind: "no_value", reason: `unmatched:${code}` };
  }
  const v = item.estimated_value;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return { kind: "no_value", reason: "no_estimated_value" };
  return { kind: "ok", value: n };
}

function creditsUsed(body: unknown): number | null {
  const used = isRecord(body) && isRecord(body.credits) ? body.credits.used : undefined;
  return typeof used === "number" && Number.isFinite(used) ? used : null;
}

/** Retry-After as seconds (delta-seconds or HTTP date); null when absent/unreadable. */
export function parseRetryAfterSeconds(header: string | null, nowMs = Date.now()): number | null {
  if (!header) return null;
  const s = header.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const at = Date.parse(s);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchDealMachineEstimatedValue(
  address: DealMachineAddress,
  opts: DealMachineOptions,
): Promise<DealMachineValueResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const maxRetries = Math.min(opts.maxRetries ?? DEALMACHINE_MAX_RETRIES, DEALMACHINE_MAX_RETRIES);
  const url = `${(opts.baseUrl ?? DEALMACHINE_BASE_URL).replace(/\/+$/, "")}${DEALMACHINE_ENRICH_ADDRESS_PATH}`;
  const body = JSON.stringify(buildDealMachineEnrichRequest(address));

  let last: { reason: string; retryAfterSeconds: number } = { reason: "not_attempted", retryAfterSeconds: 60 };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (typeof opts.beforeAttempt !== "function" || typeof opts.onAttempt !== "function") return { kind: "accounting_failed" };
    let slot: string | null;
    try {
      slot = await opts.beforeAttempt();
    } catch {
      return { kind: "accounting_failed" };
    }
    if (!slot) return attempt === 0 ? { kind: "rate_limited" } : { kind: "retryable_error", reason: "rate_limited", retryAfterSeconds: 60 };
    const callId: string = slot;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEALMACHINE_TIMEOUT_MS);
    let res: Response | null = null;
    let parsed: unknown = undefined;
    let failure: string | null = null;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body,
        signal: controller.signal,
      });
      parsed = await res.json().catch(() => undefined);
    } catch (e) {
      failure = controller.signal.aborted ? "timeout" : `network:${e instanceof Error ? e.name : "error"}`;
    } finally {
      clearTimeout(timer);
    }
    try {
      await opts.onAttempt({ callId, httpStatus: res?.status ?? null, creditsUsed: res ? creditsUsed(parsed) : null });
    } catch {
      // The row was written before the request (attempt_started), so it is still counted.
    }

    if (res && res.ok) return parseDealMachineEnrichResponse(parsed);
    const retryable = !res || res.status === 429 || res.status >= 500;
    if (!retryable) return { kind: "error", reason: `http_${res!.status}` };

    const retryAfter = res ? parseRetryAfterSeconds(res.headers.get("retry-after")) : null;
    const backoffMs = 500 * 2 ** attempt + Math.floor(random() * 250);
    const waitMs = retryAfter !== null ? retryAfter * 1000 : backoffMs;
    last = { reason: failure ?? `http_${res!.status}`, retryAfterSeconds: Math.max(retryAfter ?? 0, 60) };
    if (attempt === maxRetries) break;
    if (waitMs > DEALMACHINE_MAX_INLINE_WAIT_MS) {
      return { kind: "retryable_error", reason: last.reason, retryAfterSeconds: Math.ceil(waitMs / 1000) };
    }
    await sleep(waitMs);
  }
  return { kind: "retryable_error", ...last };
}
