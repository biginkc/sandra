import "server-only";
import { InboxHttpError } from "./http-error";
import { workspaceId } from "@/components/inbox-workspace/selection";
import { parseInboxWorksetRequest } from "./workset-request";
import type { DurableInboxScope, InboxWorksetRepository } from "./sync-gateway";

const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const error = (status: number) => Response.json({ error: "Inbox workset unavailable" }, { status, headers });

/** HTTP core, mounted only behind the disabled Inbox workspace server flag.
 * The repository creates and authorizes a scope atomically. This boundary never resolves
 * membership from browser-selected IDs, caches authority, or invents access epochs.
 */
export function createInboxWorksetHandler(repository: InboxWorksetRepository, now = Date.now) {
  return async function POST(request: Request): Promise<Response> {
    const controller = new AbortController();
    const started = now();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    const guard = () => { if (signal.aborted || now() >= started + 15_000) throw Error("Request expired"); };
    try {
      if (request.method !== "POST") return error(405);
      if (new URL(request.url).search) return error(400);
      if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return error(415);
      const session = await repository.authenticate(request, signal);
      guard();
      if (!session || !uuid.test(session.userId) || !session.sessionId || !Number.isFinite(session.expiresAt) || session.expiresAt <= now()) return error(401);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      reader = request.body?.getReader();
      if (!reader) return error(400);
      // Limit the envelope before JSON parsing, including chunked requests with no length header.
      for (;;) {
        guard();
        const part = await reader.read();
        guard();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 16_384) { controller.abort(); void reader.cancel().catch(() => {}); return error(413); }
        chunks.push(part.value);
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { return error(400); }
      const input = parseInboxWorksetRequest(parsed);
      if (!input) return error(400);
      guard();
      if (session.expiresAt <= now()) return error(401);
      const stored = await repository.createScope(session, input, signal);
      const scope = structuredClone(stored);
      guard();
      if (!validScope(scope) || scope.orgId !== input.orgId || scope.userId !== session.userId || scope.sessionId !== session.sessionId ||
          scope.expiresAt <= now() || scope.expiresAt > now() + 900_000 || scope.targets.length > input.limit || session.expiresAt <= now()) return error(503);
      // Last authority check closes create-to-response revocation; scope visibility is also rechecked.
      const access = await repository.getAccess(session, scope.orgId, signal);
      guard();
      const current = await repository.getScope(scope.id, signal);
      guard();
      if (!access || !access.sessionActive || access.activeMembershipCount !== 1 || access.status !== "active" || access.deletionPrepared ||
          access.epoch !== scope.accessEpoch || (access.expiresAt !== null && (!Number.isFinite(access.expiresAt) || access.expiresAt <= now())) ||
          !current || !sameScope(scope, current) || session.expiresAt <= now() || scope.expiresAt <= now()) return error(403);
      return Response.json({
        scopeId: scope.id, orgId: scope.orgId, requesterId: scope.userId, sessionId: scope.sessionId,
        accessEpoch: scope.accessEpoch, generation: scope.generation, expiresAt: scope.expiresAt,
        orderedIds: scope.targets.map(target => workspaceId(target.kind === "known_conversation" ? { kind: "conversation", orgId: scope.orgId, conversationId: target.id } : { kind: "unknown_sender_group", orgId: scope.orgId, senderGroupId: target.id })),
      }, { status: 201, headers });
    } catch (failure) {
      controller.abort();
      void reader?.cancel().catch(() => {});
      return error(failure instanceof InboxHttpError ? failure.status : 503);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reader?.releaseLock();
    }
  };
}

function validScope(scope: DurableInboxScope): boolean {
  if (!scope || !uuid.test(scope.id) || !scope.generation || !scope.accessEpoch || !Number.isFinite(scope.expiresAt) || !Array.isArray(scope.targets) || scope.targets.length > 500) return false;
  const keys = new Set<string>();
  for (const target of scope.targets) {
    if (!target || !["known_conversation", "unknown_sender"].includes(target.kind) || !uuid.test(target.id)) return false;
    const key = `${target.kind}:${target.id}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}
function sameScope(a: DurableInboxScope, b: DurableInboxScope): boolean {
  return a.id === b.id && a.orgId === b.orgId && a.userId === b.userId && a.sessionId === b.sessionId && a.accessEpoch === b.accessEpoch &&
    a.generation === b.generation && a.expiresAt === b.expiresAt && JSON.stringify(a.targets) === JSON.stringify(b.targets);
}
