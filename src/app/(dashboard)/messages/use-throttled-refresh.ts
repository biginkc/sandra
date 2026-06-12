"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

/**
 * Floor between server re-renders. The cockpit page is expensive to
 * regenerate (threads + queue + stats), and during an active campaign the
 * worker flips a `messages` row every few seconds — refreshing per event
 * keeps the page in a permanent rebuild and starves interactivity
 * (2026-06-12 incident). 10s keeps the inbox feeling live (optimistic
 * row merges still paint instantly) while capping rebuild cost.
 */
const DEFAULT_MIN_INTERVAL_MS = 10_000;

/**
 * Coalesces high-frequency `router.refresh()` requests (Supabase Realtime
 * events) into at most one server re-render per `minIntervalMs`:
 *
 * - Outside the window → refresh immediately (leading edge).
 * - Inside the window → arm a single trailing refresh at the window end;
 *   further requests collapse into it.
 * - Tab hidden → never refresh; remember we're stale and reconcile
 *   IMMEDIATELY (window bypassed) when the tab becomes visible again —
 *   returning is a user action, and the operator must not read stale
 *   unread counts while the throttle runs out.
 *
 * The returned callback has a stable identity for the component's
 * lifetime — interval changes apply via ref without tearing down pending
 * trailing timers or re-running subscriber effects that depend on it.
 */
export function useThrottledRefresh(
  minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS,
): () => void {
  const router = useRouter();
  const lastRefreshAt = useRef(0);
  const trailingTimer = useRef<number | null>(null);
  const staleWhileHidden = useRef(false);

  const intervalRef = useRef(minIntervalMs);
  const routerRef = useRef(router);
  useEffect(() => {
    intervalRef.current = minIntervalMs;
    routerRef.current = router;
  }, [minIntervalMs, router]);

  const clearTrailing = useCallback(() => {
    if (trailingTimer.current !== null) {
      window.clearTimeout(trailingTimer.current);
      trailingTimer.current = null;
    }
  }, []);

  const refreshNow = useCallback(() => {
    if (document.visibilityState === "hidden") {
      // A trailing timer can fire after the user tabs away — defer to the
      // visibilitychange reconcile instead of rebuilding an unseen page.
      staleWhileHidden.current = true;
      return;
    }
    lastRefreshAt.current = Date.now();
    // Ref, not the hook return: keeps refreshNow (and everything built on
    // it) identity-stable even if the router object itself is not, so a
    // re-render can never tear down an armed trailing timer or churn
    // subscriber effects.
    routerRef.current.refresh();
  }, []);

  const requestRefresh = useCallback(() => {
    if (document.visibilityState === "hidden") {
      staleWhileHidden.current = true;
      return;
    }
    const elapsed = Date.now() - lastRefreshAt.current;
    if (elapsed >= intervalRef.current) {
      refreshNow();
      return;
    }
    if (trailingTimer.current !== null) return;
    trailingTimer.current = window.setTimeout(() => {
      trailingTimer.current = null;
      refreshNow();
    }, intervalRef.current - elapsed);
  }, [refreshNow]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      // Pending state is EITHER an event that arrived while hidden OR a
      // trailing timer armed before the tab went away — both mean the page
      // is staler than the user expects on return.
      if (!staleWhileHidden.current && trailingTimer.current === null) return;
      staleWhileHidden.current = false;
      // Bypass the throttle window: this is the first rebuild the user
      // will actually see. Any armed trailing timer is folded into it.
      clearTrailing();
      refreshNow();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTrailing();
    };
  }, [clearTrailing, refreshNow]);

  return requestRefresh;
}
