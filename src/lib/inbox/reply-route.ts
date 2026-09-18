import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createInboxReplyRepository, InboxReplyApiError, type InboxReplyClient } from "./reply-api";
import { InvalidInboxActionError } from "./action-definition";
import { isInboxSameOrigin } from "./same-origin";
import { isInboxPilotRequest, type InboxPilotAuthClient } from "./pilot-cohort";
import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { canAccessMessagesAndLeadsBoard } from "@/lib/auth/surface-access";
const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
// Mirrors action-route.ts's shape (flag-first, same-origin, json-only, body
// cap, deadline, error mapping) for the bulk-reply lane. action-route.ts
// itself is untouched; nothing here imports from or is imported by it.
export async function inboxReplyRoute(request: Request, action: "prepare" | "accept" | "status" | "recover", operationId?: string) {
    // Admission stops on rollback; authenticated receipt reads remain available.
    const admission = action !== "status" && action !== "recover";
    if (admission && process.env.INBOX_REPLIES_SERVER_ENABLED !== "1")
        return Response.json({ error: "Not found" }, { status: 404, headers });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel().catch(() => { }); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        const url = new URL(request.url);
        // Copied from action-route.ts: recover takes exactly the two
        // idempotencyKey+preparationId query params, everything else takes
        // none.
        if ((action === "recover" ? [...url.searchParams.keys()].length !== 2 || !url.searchParams.has("idempotencyKey") || !url.searchParams.has("preparationId") : !!url.search) || !isInboxSameOrigin(request))
            throw new InboxReplyApiError(403);
        let raw = "";
        if (action === "prepare" || action === "accept") {
            if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
                throw new InboxReplyApiError(415);
            reader = request.body?.getReader();
            if (!reader)
                throw new InboxReplyApiError(400);
            const chunks: Uint8Array[] = [];
            let size = 0;
            // Copied from action-route.ts: prepare keeps the large template/
            // targets cap; accept carries only a preparationId+idempotencyKey
            // reference, so it gets the same tight cap as metadata accept.
            const limit = action === "prepare" ? 131072 : 1024;
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
            try {
                raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            }
            catch {
                throw new InboxReplyApiError(400);
            }
        }
        const client = await createClient();
        if (admission && !(await isInboxPilotRequest(client as unknown as InboxPilotAuthClient)))
            return Response.json({ error: "Not found" }, { status: 404, headers });
        if (admission && !canAccessMessagesAndLeadsBoard(await getCallerMembershipsOrThrow()))
            return Response.json({ error: "Not found" }, { status: 404, headers });
        const repository = createInboxReplyRepository(client as unknown as InboxReplyClient);
        if (action === "prepare")
            return Response.json(await repository.prepare(raw, signal), { headers });
        if (action === "accept")
            return Response.json(await repository.accept(raw, signal), { headers });
        if (action === "recover")
            return Response.json(await repository.recover(url.searchParams.get("preparationId") ?? "", url.searchParams.get("idempotencyKey") ?? "", signal), { headers });
        if (!operationId)
            throw new InboxReplyApiError(400);
        return Response.json(await repository.status(operationId, signal), { headers });
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
