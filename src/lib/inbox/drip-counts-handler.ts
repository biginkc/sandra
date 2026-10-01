import "server-only";

import { parseInboxFilter } from "./filter-contract";
import { InboxHttpError } from "./http-error";
import { reportInboxFailure } from "./report-failure";
import type { InboxDripCounts } from "./drip-markers";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };

export interface InboxDripCountsRepository {
  counts(orgId: string, filter: Record<string, unknown>, signal: AbortSignal): Promise<InboxDripCounts>;
}

/** Dedicated drip-view count path. It never falls back to the generic counts RPC. */
export function createInboxDripCountsHandler(repository: InboxDripCountsRepository, now = Date.now) {
  return async (request: Request): Promise<Response> => {
    const controller = new AbortController();
    const started = now();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const guard = () => { signal.throwIfAborted(); if (now() >= started + 15_000) throw Error("Expired"); };
    try {
      if (request.method !== "GET" || new TextEncoder().encode(request.url).length > 16_384) throw new InboxHttpError(400);
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
      if (!filter || (filter.view !== "in_drip" && filter.view !== "drip_replied")) throw new InboxHttpError(400);
      const counts = await repository.counts(orgId, filter, signal);
      guard();
      return Response.json(counts, { headers });
    } catch (error) {
      if (!request.signal.aborted && !(error instanceof InboxHttpError))
        reportInboxFailure("inbox_drip_counts", controller.signal.aborted ? "timeout" : "unexpected_failure");
      controller.abort();
      return Response.json({ error: "Inbox counts unavailable" }, { status: error instanceof InboxHttpError ? error.status : 503, headers });
    } finally { clearTimeout(timer); }
  };
}
