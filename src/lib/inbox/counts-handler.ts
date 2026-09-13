import "server-only";
import { parseInboxFilter } from "./filter-contract";
import { InboxHttpError } from "./http-error";
import type { InboxDataRepository } from "./supabase-sync-repository";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
export function createInboxCountsHandler(repository: InboxDataRepository, now = Date.now) {
  return async (request: Request): Promise<Response> => {
    const controller = new AbortController(), started = now();
    const timer = setTimeout(() => controller.abort(), 15000);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const guard = () => { signal.throwIfAborted(); if (now() >= started + 15000) throw Error("Expired"); };
    try {
      if (request.method !== "GET" || new TextEncoder().encode(request.url).length > 16384) throw new InboxHttpError(400);
      const params = new URL(request.url).searchParams;
      for (const key of params.keys()) if (!["orgId", "view", "hide_noise", "search"].includes(key) || params.getAll(key).length !== 1) throw new InboxHttpError(400);
      const orgId = params.get("orgId");
      if (!orgId || !uuid.test(orgId)) throw new InboxHttpError(400);
      const raw: Record<string, unknown> = { view: params.get("view") };
      if (params.has("hide_noise")) {
        if (!["true", "false"].includes(params.get("hide_noise")!)) throw new InboxHttpError(400);
        raw.hide_noise = params.get("hide_noise") === "true";
      }
      if (params.has("search")) raw.search = params.get("search");
      const filter = parseInboxFilter(raw);
      if (!filter) throw new InboxHttpError(400);
      const session = await repository.authenticate(request, signal); guard();
      if (!session || !uuid.test(session.userId) || !session.sessionId || !Number.isFinite(session.expiresAt) || session.expiresAt <= now()) throw new InboxHttpError(401);
      const counts = await repository.getCounts(session, orgId, filter, signal); guard();
      if (session.expiresAt <= now()) throw new InboxHttpError(401);
      return Response.json({ ...counts, updating: null }, { headers });
    } catch (error) {
      controller.abort();
      return Response.json({ error: "Inbox counts unavailable" }, { status: error instanceof InboxHttpError ? error.status : 503, headers });
    } finally { clearTimeout(timer); }
  };
}
