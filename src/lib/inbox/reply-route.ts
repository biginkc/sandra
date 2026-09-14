import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createInboxReplyRepository, InboxReplyApiError, type InboxReplyClient } from "./reply-api";
import { InvalidInboxActionError } from "./action-definition";
import { isInboxSameOrigin } from "./same-origin";
const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
// Mirrors action-route.ts's shape (flag-first, same-origin, json-only, body
// cap, deadline, error mapping) for the bulk-reply prepare lane specifically.
// action-route.ts itself is untouched; nothing here imports from or is
// imported by it.
export async function inboxReplyRoute(request: Request, action: "prepare") {
    if (process.env.INBOX_REPLIES_SERVER_ENABLED !== "1")
        return Response.json({ error: "Not found" }, { status: 404, headers });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel().catch(() => { }); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        const url = new URL(request.url);
        if (!!url.search || !isInboxSameOrigin(request))
            throw new InboxReplyApiError(403);
        if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
            throw new InboxReplyApiError(415);
        reader = request.body?.getReader();
        if (!reader)
            throw new InboxReplyApiError(400);
        const chunks: Uint8Array[] = [];
        let size = 0;
        const limit = 131072;
        for (;;) {
            signal.throwIfAborted();
            const part = await reader.read();
            signal.throwIfAborted();
            if (part.done)
                break;
            size += part.value.byteLength;
            if (size > limit) {
                cancel();
                throw new InboxReplyApiError(413);
            }
            chunks.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        let raw: string;
        try {
            raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }
        catch {
            throw new InboxReplyApiError(400);
        }
        const client = await createClient(), repository = createInboxReplyRepository(client as unknown as InboxReplyClient);
        if (action === "prepare")
            return Response.json(await repository.prepare(raw, signal), { headers });
        throw new InboxReplyApiError(400);
    }
    catch (error) {
        cancel();
        // C10: never log/echo the request body, template, phone numbers, or
        // rendered variables — only the mapped C7 code and status ever leave
        // this boundary.
        return Response.json({ error: error instanceof InboxReplyApiError ? error.code : "action_unavailable" }, { status: error instanceof InboxReplyApiError ? error.status : error instanceof InvalidInboxActionError ? 400 : 503, headers });
    }
    finally {
        signal.removeEventListener("abort", cancel);
        reader?.releaseLock();
    }
}
