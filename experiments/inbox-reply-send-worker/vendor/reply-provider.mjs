// [Astra B5] Runtime (plain-JS, type-erased) copy of
// src/lib/inbox/reply-provider.ts's createSendilloReplyTransport, vendored
// here so the Docker image (which has no TypeScript toolchain) can COPY and
// run it directly. Behaviorally byte-for-byte identical to the TS source
// with only type annotations/`type` exports removed — no logic differs.
// KEEP IN SYNC with src/lib/inbox/reply-provider.ts by hand; if that file's
// createSendilloReplyTransport body changes, mirror the change here too.
// Never invoked in any proof in this PR — proofs always inject
// INBOX_REPLY_SEND_TEST_TRANSPORT_MODULE instead (server.mjs's loadTransport).
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const ENDPOINT = "https://www.sendillo.com/api/v1/messages";
function stringAt(value, ...keys) {
  for (const key of keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    value = value[key];
  }
  return typeof value === "string" && value.length > 0 ? value : null;
}
async function withAbort(promise, signal) {
  signal.throwIfAborted();
  let listener;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      listener = () => reject(signal.reason); signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
    })]);
  } finally { if (listener) signal.removeEventListener("abort", listener); }
}
export function createSendilloReplyTransport(apiKey, transport = fetch) {
  if (!apiKey || /[\r\n]/.test(apiKey)) throw Error("Reply provider configuration missing");
  return async (input, cancellation) => {
    if (!input || typeof input.body !== "string" || !input.body.trim() || input.body.length > 1600 || !PHONE.test(input.from) || !PHONE.test(input.to)) return { kind: "not_attempted", reason: "invalid_input" };
    if (cancellation.aborted) return { kind: "not_attempted", reason: "cancelled_before_dispatch" };
    const deadline = AbortSignal.any([cancellation, AbortSignal.timeout(10_000)]);
    let reader;
    try {
      const response = await withAbort(transport(ENDPOINT, {
        method: "POST", redirect: "error", cache: "no-store", signal: deadline,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: input.from, to: input.to, body: input.body }),
      }), deadline);
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return { kind: "uncertain", reason: "unverified_http_rejection" }; }
      reader = response.body?.getReader();
      if (!reader) return { kind: "uncertain", reason: "missing_acceptance_reference" };
      const chunks = []; let size = 0;
      for (;;) {
        const part = await withAbort(reader.read(), deadline);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 16_384) return { kind: "uncertain", reason: "response_too_large" };
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let parsed;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { return { kind: "uncertain", reason: "missing_acceptance_reference" }; }
      const externalId = stringAt(parsed, "data", "messageId") ?? stringAt(parsed, "messageId") ?? stringAt(parsed, "data", "id") ?? stringAt(parsed, "id");
      if (!externalId || externalId.length > 512) return { kind: "uncertain", reason: "missing_acceptance_reference" };
      const providerStatus = stringAt(parsed, "data", "status") ?? stringAt(parsed, "status") ?? "accepted";
      const root = parsed;
      const nested = root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : {};
      if (root.success === false || nested.success === false || root.accepted === false || nested.accepted === false ||
        ["failed", "rejected", "error", "cancelled", "canceled", "undeliverable", "delivery_failed"].includes(providerStatus.trim().toLowerCase())) {
        return { kind: "uncertain", reason: "contradictory_response", reportedExternalId: externalId };
      }
      return { kind: "accepted", provider: "sendillo", externalId, providerStatus: providerStatus.slice(0, 128) };
    } catch { return { kind: "uncertain", reason: "transport_or_timeout" }; }
    finally { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
  };
}
