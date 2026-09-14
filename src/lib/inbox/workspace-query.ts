import { QueryClient } from "@tanstack/react-query";

export interface InboxQueryIdentity { orgId: string; userId: string; sessionId: string; accessEpoch: string }
export type InboxQueryResource = "detail" | "counts" | "receipt" | "context";
const limits: Record<InboxQueryResource, number> = { detail: 20, counts: 1, receipt: 10, context: 4 };
/** Dedicated, memory-only cache. Summary rows belong exclusively to TanStack DB.
 * Detail responses are bounded by the server to 50 messages per page; older-page
 * support must preserve a two-page cap rather than accumulating the transcript.
 */
export function createInboxQueryCache(identity: InboxQueryIdentity) {
  const prefix = ["inbox", identity.orgId, identity.userId, identity.sessionId, identity.accessEpoch] as const;
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: false, staleTime: 30_000, gcTime: 300_000,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
  }, mutations: { retry: false } } });
  const recent = { detail: new Map<string, true>(), counts: new Map<string, true>(), receipt: new Map<string, true>(), context: new Map<string, true>() };
  let generation = 0;
  let closed = false;
  const key = (resource: InboxQueryResource, id: string) => [...prefix, resource, id];
  function reserve(resource: InboxQueryResource, id: string) {
    const entries = recent[resource];
    entries.delete(id); entries.set(id, true);
    while (entries.size > limits[resource]) {
      const oldest = entries.keys().next().value!;
      entries.delete(oldest);
      void client.cancelQueries({ queryKey: key(resource, oldest), exact: true });
      client.removeQueries({ queryKey: key(resource, oldest), exact: true });
    }
  }
  return {
    client,
    async read<T>(resource: InboxQueryResource, id: string, load: (signal: AbortSignal) => Promise<T>, fresh = false): Promise<T> {
      if (closed) throw new DOMException("Inbox access ended", "AbortError");
      reserve(resource, id);
      const token = generation;
      const result = await client.fetchQuery({ queryKey: key(resource, id), staleTime: fresh ? 0 : resource === "counts" ? 10_000 : 30_000,
        queryFn: async ({ signal }) => {
          const value = await load(signal);
          signal.throwIfAborted();
          if (token !== generation) throw new DOMException("Inbox access changed", "AbortError");
          return value;
        } });
      if (token !== generation || closed) throw new DOMException("Inbox access changed", "AbortError");
      return result;
    },
    invalidate(resource: InboxQueryResource, id: string) {
      recent[resource].delete(id);
      void client.cancelQueries({ queryKey: key(resource, id), exact: true });
      client.removeQueries({ queryKey: key(resource, id), exact: true });
    },
    close() {
      closed = true; generation++;
      void client.cancelQueries();
      client.clear();
      for (const entries of Object.values(recent)) entries.clear();
    },
  };
}
