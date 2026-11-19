"use client";

import { useEffect, useState } from "react";

import { timeClientCall } from "@/lib/perf/client-action-timing";

const REFRESH_WINDOW_MS = 60_000;

export type MyLeadsBadgeRefresh = () => Promise<
  | { ok: true; count: number }
  | { ok: false }
>;

export function MyLeadsNavBadge({
  initialCount,
  onRefresh,
  needsAttention = false,
}: {
  initialCount?: number | null;
  onRefresh?: MyLeadsBadgeRefresh;
  /** unified_queue on: the count is the leads that need attention (Due + New reply + Broken), not Not contacted leads. */
  needsAttention?: boolean;
}) {
  const [count, setCount] = useState(normalizeCount(initialCount));

  const [seenInitial, setSeenInitial] = useState(initialCount);
  if (seenInitial !== initialCount) {
    setSeenInitial(initialCount);
    setCount(normalizeCount(initialCount));
  }

  useEffect(() => {
    if (!onRefresh) return;
    return subscribeBadge(onRefresh, (next) => setCount(normalizeCount(next)));
  }, [onRefresh]);

  if (count === null || count === 0) return null;

  return (
    <span
      aria-hidden="true"
      className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-white/15 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
      data-testid="my-leads-badge"
      title={badgeLabel(count, needsAttention)}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function badgeLabel(count: number, needsAttention: boolean): string {
  if (!needsAttention) return `${count} Not contacted leads`;
  return count === 1 ? "1 lead needs attention" : `${count} leads need attention`;
}

function normalizeCount(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

// Desktop and mobile nav both mount a badge; they share one focus listener and one
// throttle per refresh source so a single foreground event triggers a single read.
type BadgeSource = { listeners: Set<(count: number) => void>; lastRefreshAt: number; detach?: () => void };
const badgeSources = new Map<MyLeadsBadgeRefresh, BadgeSource>();

function subscribeBadge(onRefresh: MyLeadsBadgeRefresh, listener: (count: number) => void): () => void {
  let source = badgeSources.get(onRefresh);
  if (!source) {
    source = { listeners: new Set(), lastRefreshAt: 0 };
    badgeSources.set(onRefresh, source);
  }
  const current = source;
  current.listeners.add(listener);
  if (!current.detach) {
    const refreshWhenForeground = () => {
      if (!document.hidden) void refreshBadgeSource(onRefresh, current);
    };
    document.addEventListener("visibilitychange", refreshWhenForeground);
    window.addEventListener("focus", refreshWhenForeground);
    current.detach = () => {
      document.removeEventListener("visibilitychange", refreshWhenForeground);
      window.removeEventListener("focus", refreshWhenForeground);
    };
  }
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;
    current.detach?.();
    current.detach = undefined;
  };
}

async function refreshBadgeSource(onRefresh: MyLeadsBadgeRefresh, source: BadgeSource) {
  const now = Date.now();
  if (now - source.lastRefreshAt < REFRESH_WINDOW_MS) return;
  source.lastRefreshAt = now;
  try {
    const result = await timeClientCall("refreshMyLeadsBadge", onRefresh)();
    if (result.ok) for (const listener of source.listeners) listener(result.count);
  } catch {
    // Keep the last confirmed count visible when a foreground refresh fails.
  }
}
