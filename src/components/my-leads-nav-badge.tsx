"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const REFRESH_WINDOW_MS = 60_000;

export type MyLeadsBadgeRefresh = () => Promise<
  | { ok: true; count: number }
  | { ok: false }
>;

export function MyLeadsNavBadge({
  initialCount,
  onRefresh,
}: {
  initialCount?: number | null;
  onRefresh?: MyLeadsBadgeRefresh;
}) {
  const [count, setCount] = useState(normalizeCount(initialCount));
  const lastRefreshAt = useRef(0);

  const refresh = useCallback(async () => {
    if (!onRefresh) return;
    const now = Date.now();
    if (now - lastRefreshAt.current < REFRESH_WINDOW_MS) return;
    lastRefreshAt.current = now;

    try {
      const result = await onRefresh();
      if (result.ok) setCount(normalizeCount(result.count));
    } catch {
      // Keep the last confirmed count visible when a foreground refresh fails.
    }
  }, [onRefresh]);

  useEffect(() => {
    if (!onRefresh) return;

    const refreshWhenForeground = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", refreshWhenForeground);
    window.addEventListener("focus", refreshWhenForeground);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenForeground);
      window.removeEventListener("focus", refreshWhenForeground);
    };
  }, [onRefresh, refresh]);

  if (count === null || count === 0) return null;

  return (
    <span
      aria-hidden="true"
      className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-white/15 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
      data-testid="my-leads-badge"
      title={`${count} Not contacted leads`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function normalizeCount(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}
