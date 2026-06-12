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
 * - Tab hidden → never refresh; remember we're stale and reconcile once
 *   when the tab becomes visible again.
 */
export function useThrottledRefresh(
  minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS,
): () => void {
  const router = useRouter();
  const lastRefreshAt = useRef(0);
  const trailingTimer = useRef<number | null>(null);
  const staleWhileHidden = useRef(false);

  const refreshNow = useCallback(() => {
    if (document.visibilityState === "hidden") {
      // A trailing timer can fire after the user tabs away — defer to the
      // visibilitychange reconcile instead of rebuilding an unseen page.
      staleWhileHidden.current = true;
      return;
    }
    lastRefreshAt.current = Date.now();
    router.refresh();
  }, [router]);

  const requestRefresh = useCallback(() => {
    if (document.visibilityState === "hidden") {
      staleWhileHidden.current = true;
      return;
    }
    const elapsed = Date.now() - lastRefreshAt.current;
    if (elapsed >= minIntervalMs) {
      refreshNow();
      return;
    }
    if (trailingTimer.current !== null) return;
    trailingTimer.current = window.setTimeout(() => {
      trailingTimer.current = null;
      refreshNow();
    }, minIntervalMs - elapsed);
  }, [minIntervalMs, refreshNow]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (!staleWhileHidden.current) return;
      staleWhileHidden.current = false;
      requestRefresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (trailingTimer.current !== null) {
        window.clearTimeout(trailingTimer.current);
        trailingTimer.current = null;
      }
    };
  }, [requestRefresh]);

  return requestRefresh;
}
