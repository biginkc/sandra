import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createInboxActionRepository, InboxActionApiError, type InboxActionClient } from "./action-api";
import { InvalidInboxActionError, parseInboxActionAcceptance } from "./action-definition";
import { isInboxSameOrigin } from "./same-origin";
const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
export async function inboxActionRoute(request: Request, action: "prepare" | "accept" | "status" | "assignees" | "recover", operationId?: string) {
    if (process.env.INBOX_ACTIONS_SERVER_ENABLED !== "1")
        return Response.json({ error: "Not found" }, { status: 404, headers });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel().catch(() => { }); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        const url = new URL(request.url);
        if ((action === "recover" ? [...url.searchParams.keys()].length !== 2 || !url.searchParams.has("idempotencyKey") || !url.searchParams.has("preparationId") : !!url.search) || !isInboxSameOrigin(request))
            throw new InboxActionApiError(403);
        let raw = "";
        if (action === "prepare" || action === "accept") {
            if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
                throw new InboxActionApiError(415);
            reader = request.body?.getReader();
            if (!reader)
                throw new InboxActionApiError(400);
            const chunks: Uint8Array[] = [];
            let size = 0;
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
                    throw new InboxActionApiError(413);
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
                throw new InboxActionApiError(400);
            }
        }
        const client = await createClient(), repository = createInboxActionRepository(client as unknown as InboxActionClient);
        if (action === "prepare")
            return Response.json(await repository.prepare(raw, signal), { headers });
        if (action === "accept") {
            const reference = parseInboxActionAcceptance(raw);
            return Response.json(await repository.accept(reference.preparationId, reference.idempotencyKey, signal), { headers });
        }
        if (action === "assignees") return Response.json({ members: await repository.assignees(signal) }, { headers });
        if (action === "recover") return Response.json(await repository.recover(url.searchParams.get("preparationId") ?? "", url.searchParams.get("idempotencyKey") ?? "", signal), { headers });
        if (!operationId)
            throw new InboxActionApiError(400);
        return Response.json(await repository.status(operationId, signal), { headers });
    }
    catch (error) {
        cancel();
        return Response.json({ error: error instanceof InboxActionApiError ? error.code : "action_unavailable" }, { status: error instanceof InboxActionApiError ? error.status : error instanceof InvalidInboxActionError ? 400 : 503, headers });
    }
    finally {
        signal.removeEventListener("abort", cancel);
        reader?.releaseLock();
    }
}
