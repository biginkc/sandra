"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadPage } from "@/lib/messages/list-threads";

/** Rows and counts are replaced atomically; no cross-request inbox cache. */
export function useInboxSnapshot(initial: ThreadPage, query: string, enabled: boolean) {
  const [loaded, setLoaded] = useState<{ source: ThreadPage; query: string; page: ThreadPage } | null>(null);
  const [failed, setFailed] = useState(false);
  const flight = useRef<{ controller: AbortController; dirty: boolean; promise: Promise<void> } | null>(null);
  useEffect(() => {
    return () => {
      flight.current?.controller.abort();
      flight.current = null;
    };
  }, [initial, query, enabled]);

  const refresh = useCallback(function revalidate(): Promise<void> {
    if (!enabled || document.visibilityState !== "visible") return Promise.resolve();
    if (flight.current) {
      flight.current.dirty = true;
      return flight.current.promise;
    }
    const current = { controller: new AbortController(), dirty: false, promise: Promise.resolve() };
    flight.current = current;
    current.promise = (async () => {
      try {
        const params = new URLSearchParams(query);
        // Native selection changes do not reload the list. Pin its CURRENT
        // selected row when a later event refreshes an Unread snapshot.
        const selected = new URLSearchParams(window.location.search).get("thread");
        if (selected) params.set("thread", selected);
        const response = await fetch(`/api/messages/inbox?${params}`, { cache: "no-store", signal: current.controller.signal });
        if (!response.ok) throw new Error("Inbox refresh failed");
        const { page } = await response.json() as { page: ThreadPage };
        if (!page || !Array.isArray(page.threads) || !page.counts || !Number.isInteger(page.page)) throw new Error("Invalid inbox snapshot");
        if (current.controller.signal.aborted) return;
        setLoaded({ source: initial, query, page });
        setFailed(false);
      } catch {
        if (!current.controller.signal.aborted) setFailed(true);
      } finally {
        if (flight.current === current) {
          flight.current = null;
          if (current.dirty) void revalidate();
        }
      }
    })();
    return current.promise;
  }, [initial, query, enabled]);

  useEffect(() => {
    const reconcile = () => { void refresh(); };
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    return () => {
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
    };
  }, [refresh]);
  return { page: loaded?.source === initial && loaded.query === query ? loaded.page : initial, refresh, failed };
}
