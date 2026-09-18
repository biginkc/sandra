import { createClient } from "@/lib/supabase/server";
import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { canAccessMessagesAndLeadsBoard } from "@/lib/auth/surface-access";
import { isInboxPilotRequest, type InboxPilotAuthClient } from "@/lib/inbox/pilot-cohort";
import { isInboxSameOrigin } from "@/lib/inbox/same-origin";
import { InboxHttpError } from "@/lib/inbox/http-error";
import { createSelectionReviewRepository, parseSelectionReview, type SelectionReviewClient } from "@/lib/inbox/selection-review";
const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
export async function POST(request: Request) {
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") return Response.json({ error: "Not found" }, { status: 404, headers });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (!isInboxSameOrigin(request)) throw new InboxHttpError(403);
    if (new URL(request.url).search || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new InboxHttpError(400);
    const client = await createClient();
    if (!(await isInboxPilotRequest(client as unknown as InboxPilotAuthClient)) || !canAccessMessagesAndLeadsBoard(await getCallerMembershipsOrThrow())) return Response.json({ error: "Not found" }, { status: 404, headers });
    reader = request.body?.getReader();
    if (!reader) throw new InboxHttpError(400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) { cancel(); throw new InboxHttpError(400); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new InboxHttpError(400); }
    const result = await createSelectionReviewRepository(client as unknown as SelectionReviewClient)(parseSelectionReview(raw), signal);
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json({ error: "Inbox selection review unavailable" }, { status: error instanceof InboxHttpError ? error.status : 503, headers });
  } finally { signal.removeEventListener("abort", cancel); reader?.releaseLock(); }
}
