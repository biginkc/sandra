"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadPage } from "@/lib/messages/list-threads";

export type InboxRefreshSnapshot = { page: ThreadPage; unknown: number; dismissed: number };

export function useInboxRefresh(initial: InboxRefreshSnapshot, query: string, enabled: boolean) {
  const [result, setResult] = useState<{ source: InboxRefreshSnapshot; query: string; snapshot: InboxRefreshSnapshot } | null>(null);
  const [failure, setFailure] = useState<{ source: InboxRefreshSnapshot; query: string } | null>(null);
  const pending = useRef<{ abort: AbortController; again: boolean } | null>(null);
  useEffect(() => () => { pending.current?.abort.abort(); pending.current = null; }, [initial, query, enabled]);
  const refresh = useCallback(function reconcile(): void {
    if (!enabled || document.visibilityState !== "visible") return;
    if (pending.current) { pending.current.again = true; return; }
    const request = { abort: new AbortController(), again: false };
    pending.current = request;
    void (async () => {
      try {
        const params = new URLSearchParams(query);
        const selected = new URLSearchParams(window.location.search).get("thread");
        if (selected) params.set("thread", selected);
        const response = await fetch(`/api/messages/inbox-refresh?${params}`, { cache: "no-store", signal: request.abort.signal });
        if (!response.ok) throw new Error("refresh failed");
        const snapshot = await response.json() as InboxRefreshSnapshot;
        if (!snapshot.page || !Array.isArray(snapshot.page.threads) || !snapshot.page.counts ||
          !Number.isInteger(snapshot.unknown) || !Number.isInteger(snapshot.dismissed)) throw new Error("invalid snapshot");
        if (request.abort.signal.aborted) return;
        setResult({ source: initial, query, snapshot });
        setFailure(null);
      } catch {
        if (!request.abort.signal.aborted) setFailure({ source: initial, query });
      } finally {
        if (pending.current === request) {
          pending.current = null;
          if (request.again) reconcile();
        }
      }
    })();
  }, [initial, query, enabled]);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); };
  }, [refresh]);
  return { snapshot: result?.source === initial && result.query === query ? result.snapshot : initial,
    failed: failure?.source === initial && failure.query === query, refresh };
}
