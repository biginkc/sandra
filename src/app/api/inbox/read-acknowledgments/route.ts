import { createClient } from "@/lib/supabase/server";
import { createInboxReadRepository, InboxReadError, type InboxReadClient } from "@/lib/inbox/read-api";
const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
export async function POST(request: Request) {
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") return Response.json({ error: "Not found" }, { status: 404, headers });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const url = new URL(request.url), origin = request.headers.get("origin");
    if (url.search || (origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") throw new InboxReadError(403);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new InboxReadError(415);
    reader = request.body?.getReader();
    if (!reader) throw new InboxReadError(400);
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024) { cancel(); throw new InboxReadError(413); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new InboxReadError(400); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new InboxReadError(400);
    const body = value as Record<string, unknown>;
    if (Object.keys(body).length !== 2 || typeof body.boundaryId !== "string" || typeof body.batch !== "number") throw new InboxReadError(400);
    const client = await createClient();
    const data = await createInboxReadRepository(client as unknown as InboxReadClient).acknowledge(body.boundaryId, body.batch, signal);
    return Response.json(data, { headers });
  } catch (error) {
    cancel();
    return Response.json({ error: "Inbox acknowledgment unavailable" }, { status: error instanceof InboxReadError ? error.status : 503, headers });
  } finally {
    signal.removeEventListener("abort", cancel);
    reader?.releaseLock();
  }
}
