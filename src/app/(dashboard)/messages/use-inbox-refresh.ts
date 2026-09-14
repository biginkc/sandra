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
 *
 * Leading-edge + single trailing timer, same shape as useThrottledRefresh:
 * an ambient event outside the window dispatches immediately; one inside
 * the window arms exactly one trailing refresh for the remainder of the
 * window, and further suppressed events collapse into it rather than
 * re-arming or extending it. This is required, not cosmetic — a bare
 * leading-edge-only gate drops a reconnect that lands inside the window
 * with nothing left to recover it (the realtime path doesn't either), so
 * the inbox goes stale until some other unrelated event happens to fire.
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
  // Returns whether this call was an effective dispatch — it created a new
  // request, or queued one on top of an in-flight request via `again`
  // (both mean the RPC will run again for this call's sake). False for
  // hidden/disabled/stale-scope/Unread-pin-mismatch, where nothing was or
  // will be requested. The ambient focus/online cooldown below stamps only
  // on `true`, so a no-op call never burns the throttle window.
  const refresh = useCallback(function reconcile(): boolean {
    if (activeScope.current !== scope || !enabled || document.visibilityState !== "visible") return false;
    if (pinSelection && new URLSearchParams(window.location.search).get("thread") !== selectedThreadId) return false;
    if (pending.current) { pending.current.again = true; return true; }
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
    return true;
  }, [initial, query, enabled, selectedThreadId, pinSelection, scope]);
  const previousSelection = useRef(pinSelection ? serverThreadId : null);
  useEffect(() => {
    if (previousSelection.current === selectedThreadId) return;
    previousSelection.current = selectedThreadId;
    refresh();
  }, [selectedThreadId, refresh]);
  const lastAutoRefreshAt = useRef(0);
  const autoRefreshTrailingTimer = useRef<number | null>(null);
  useEffect(() => {
    const clearAutoRefreshTrailing = () => {
      if (autoRefreshTrailingTimer.current !== null) {
        window.clearTimeout(autoRefreshTrailingTimer.current);
        autoRefreshTrailingTimer.current = null;
      }
    };
    // Re-runs the same gate at fire time (visibility/scope may have changed
    // since the timer was armed) and stamps only if it actually dispatches.
    const fireTrailingAutoRefresh = () => {
      autoRefreshTrailingTimer.current = null;
      if (refresh()) lastAutoRefreshAt.current = Date.now();
    };
    const requestAutoRefresh = () => {
      const now = Date.now();
      const elapsed = now - lastAutoRefreshAt.current;
      if (elapsed >= AUTO_REFRESH_MIN_INTERVAL_MS) {
        // Leading edge: try to dispatch now. Stamp only on an actual
        // dispatch — a no-op (hidden/disabled/stale-scope/pin-mismatch)
        // must never burn the window for the next ambient event.
        if (refresh()) lastAutoRefreshAt.current = now;
        return;
      }
      // Inside the window. A hidden tab gets no trailing timer at all —
      // returning to the tab re-fires `focus` (a fresh leading-edge
      // attempt), and useThrottledRefresh's own visibility reconcile
      // covers the realtime-driven refresh path independently.
      if (document.visibilityState !== "visible") return;
      // Suppressed: arm exactly one trailing refresh for the remainder of
      // the window. Further suppressed events collapse into it — no
      // re-arm, no extension — so a burst still yields at most one
      // trailing dispatch.
      if (autoRefreshTrailingTimer.current !== null) return;
      autoRefreshTrailingTimer.current = window.setTimeout(fireTrailingAutoRefresh, AUTO_REFRESH_MIN_INTERVAL_MS - elapsed);
    };
    window.addEventListener("focus", requestAutoRefresh);
    window.addEventListener("online", requestAutoRefresh);
    return () => {
      window.removeEventListener("focus", requestAutoRefresh);
      window.removeEventListener("online", requestAutoRefresh);
      clearAutoRefreshTrailing();
    };
  }, [refresh]);
  return { snapshot: result?.source === initial && result.query === query && result.selectedThreadId === selectedThreadId ? result.snapshot : initial,
    failed: failure?.source === initial && failure.query === query && failure.selectedThreadId === selectedThreadId, refresh };
}
