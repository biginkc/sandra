"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ThreadPage } from "@/lib/messages/list-threads";

export type InboxRefreshSnapshot = { page: ThreadPage; unknown: number; dismissed: number };

/**
 * Floor between window `focus`/`online`-triggered auto-refreshes of the
 * heavy inbox snapshot RPC. These fire on every tab refocus and network
 * reconnect with no natural rate limit — a rep alt-tabbing (or a flaky
 * connection reconnecting repeatedly) can retrigger the full inbox
 * aggregate several times inside a few seconds, on top of whatever the
 * realtime-driven throttled refresh is already doing (2026-09-14 incident:
 * the same rep's inbox was re-queried 3x in 14s, pushing the RPC into its
 * 15s timeout under concurrent load). This only gates the two ambient
 * triggers below — explicit user actions (filter change, manual retry,
 * pagination, selection change) always refresh immediately.
 */
const AUTO_REFRESH_MIN_INTERVAL_MS = 10_000;

export function useInboxRefresh(initial: InboxRefreshSnapshot, query: string, enabled: boolean, currentSelectedThreadId: string | null = null, serverThreadId: string | null = null) {
  // Only Unread uses p_include_thread_id. Ordinary selection must not start
  // another expensive inbox aggregate when its rows/counts are unchanged.
  const pinSelection = new URLSearchParams(query).get("filter") === "unread";
  const selectedThreadId = pinSelection ? currentSelectedThreadId : null;
  const [result, setResult] = useState<{ source: InboxRefreshSnapshot; query: string; selectedThreadId: string | null; snapshot: InboxRefreshSnapshot } | null>(null);
  const [failure, setFailure] = useState<{ source: InboxRefreshSnapshot; query: string; selectedThreadId: string | null } | null>(null);
  const pending = useRef<{ abort: AbortController; again: boolean } | null>(null);
  const scope = useMemo(() => ({ initial, query, enabled, selectedThreadId }), [initial, query, enabled, selectedThreadId]);
  const activeScope = useRef<typeof scope | null>(scope);
  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      activeScope.current = null;
      pending.current?.abort.abort();
      pending.current = null;
    };
  }, [scope]);
  const refresh = useCallback(function reconcile(): void {
    if (activeScope.current !== scope || !enabled || document.visibilityState !== "visible") return;
    if (pinSelection && new URLSearchParams(window.location.search).get("thread") !== selectedThreadId) return;
    if (pending.current) { pending.current.again = true; return; }
    const request = { abort: new AbortController(), again: false };
    pending.current = request;
    void (async () => {
      try {
        const params = new URLSearchParams(query);
        params.delete("thread");
        if (selectedThreadId) params.set("thread", selectedThreadId);
        const response = await fetch(`/api/messages/inbox-refresh?${params}`, { cache: "no-store", signal: request.abort.signal });
        if (!response.ok) throw new Error("refresh failed");
        const snapshot = await response.json() as InboxRefreshSnapshot;
        if (!snapshot.page || !Array.isArray(snapshot.page.threads) || !snapshot.page.counts ||
          !Number.isInteger(snapshot.unknown) || !Number.isInteger(snapshot.dismissed)) throw new Error("invalid snapshot");
        if (activeScope.current !== scope || request.abort.signal.aborted || (pinSelection && new URLSearchParams(window.location.search).get("thread") !== selectedThreadId)) return;
        setResult({ source: initial, query, selectedThreadId, snapshot });
        setFailure(null);
      } catch {
        if (!request.abort.signal.aborted) setFailure({ source: initial, query, selectedThreadId });
      } finally {
        if (pending.current === request) {
          pending.current = null;
          if (request.again) reconcile();
        }
      }
    })();
  }, [initial, query, enabled, selectedThreadId, pinSelection, scope]);
  const previousSelection = useRef(pinSelection ? serverThreadId : null);
  useEffect(() => {
    if (previousSelection.current === selectedThreadId) return;
    previousSelection.current = selectedThreadId;
    refresh();
  }, [selectedThreadId, refresh]);
  const lastAutoRefreshAt = useRef(0);
  useEffect(() => {
    const requestAutoRefresh = () => {
      // `refresh()` itself no-ops while hidden — stamping the cooldown here
      // regardless would let an `online` event that fires while the tab is
      // backgrounded burn the window without ever dispatching, dropping the
      // next legitimate `focus` refresh for up to 10s. Only stamp when the
      // call is actually going to dispatch.
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastAutoRefreshAt.current < AUTO_REFRESH_MIN_INTERVAL_MS) return;
      lastAutoRefreshAt.current = now;
      refresh();
    };
    window.addEventListener("focus", requestAutoRefresh);
    window.addEventListener("online", requestAutoRefresh);
    return () => { window.removeEventListener("focus", requestAutoRefresh); window.removeEventListener("online", requestAutoRefresh); };
  }, [refresh]);
  return { snapshot: result?.source === initial && result.query === query && result.selectedThreadId === selectedThreadId ? result.snapshot : initial,
    failed: failure?.source === initial && failure.query === query && failure.selectedThreadId === selectedThreadId, refresh };
}
