/** Bulk reply transport only. It never retries or modifies the existing Outbox
 * sender. Call only after the durable attempt marker has committed. */
export type FrozenReply = { from: string; to: string; body: string };
export type ReplyProviderResult =
  | { kind: "accepted"; provider: "sendillo"; externalId: string; providerStatus: string }
  | { kind: "not_attempted"; reason: "invalid_input" | "cancelled_before_dispatch" }
  | { kind: "uncertain"; reason: "transport_or_timeout" | "response_too_large" | "unverified_http_rejection" | "missing_acceptance_reference" | "contradictory_response"; reportedExternalId?: string };
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const ENDPOINT = "https://www.sendillo.com/api/v1/messages";
function stringAt(value: unknown, ...keys: string[]): string | null {
  for (const key of keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" && value.length > 0 ? value : null;
}
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      listener = () => reject(signal.reason); signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
    })]);
  } finally { if (listener) signal.removeEventListener("abort", listener); }
}
export function createSendilloReplyTransport(apiKey: string, transport: typeof fetch = fetch) {
  if (!apiKey || /[\r\n]/.test(apiKey)) throw Error("Reply provider configuration missing");
  return async (input: FrozenReply, cancellation: AbortSignal): Promise<ReplyProviderResult> => {
    if (!input || typeof input.body !== "string" || !input.body.trim() || input.body.length > 1600 || !PHONE.test(input.from) || !PHONE.test(input.to)) return { kind: "not_attempted", reason: "invalid_input" };
    if (cancellation.aborted) return { kind: "not_attempted", reason: "cancelled_before_dispatch" };
    const deadline = AbortSignal.any([cancellation, AbortSignal.timeout(10_000)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await withAbort(transport(ENDPOINT, {
        method: "POST", redirect: "error", cache: "no-store", signal: deadline,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: input.from, to: input.to, body: input.body }),
      }), deadline);
      // No provider idempotency or definitive rejection contract has been
      // independently verified. HTTP errors are not permission to resend.
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return { kind: "uncertain", reason: "unverified_http_rejection" }; }
      reader = response.body?.getReader();
      if (!reader) return { kind: "uncertain", reason: "missing_acceptance_reference" };
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const part = await withAbort(reader.read(), deadline);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 16_384) return { kind: "uncertain", reason: "response_too_large" };
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { return { kind: "uncertain", reason: "missing_acceptance_reference" }; }
      const externalId = stringAt(parsed, "data", "messageId") ?? stringAt(parsed, "messageId") ?? stringAt(parsed, "data", "id") ?? stringAt(parsed, "id");
      if (!externalId || externalId.length > 512) return { kind: "uncertain", reason: "missing_acceptance_reference" };
      const providerStatus = stringAt(parsed, "data", "status") ?? stringAt(parsed, "status") ?? "accepted";
      const root = parsed as Record<string, unknown>;
      const nested = root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data as Record<string, unknown> : {};
      if (root.success === false || nested.success === false || root.accepted === false || nested.accepted === false ||
        ["failed", "rejected", "error", "cancelled", "canceled", "undeliverable", "delivery_failed"].includes(providerStatus.trim().toLowerCase())) {
        // Retain the reference as reconciliation evidence, not as proof that the
        // provider accepted the send or that another attempt would be safe.
        return { kind: "uncertain", reason: "contradictory_response", reportedExternalId: externalId };
      }
      return { kind: "accepted", provider: "sendillo", externalId, providerStatus: providerStatus.slice(0, 128) };
    } catch { return { kind: "uncertain", reason: "transport_or_timeout" }; }
    finally { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
  };
}
