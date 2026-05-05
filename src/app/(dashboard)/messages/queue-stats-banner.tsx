"use client";

import { useEffect, useState } from "react";

import { getQueueStats, type QueueStats } from "./actions";

const POLL_INTERVAL_MS = 30_000;

/**
 * Live stats banner above the Outbox queue table.
 *
 * Renders queued / sentToday / failedToday counts, plus the relative
 * "next release" time and humanized drain ETA. Polls getQueueStats
 * every 30s while document.visibilityState === "visible"; pauses while
 * hidden; fires one immediate refresh when the tab returns to visible
 * so an operator coming back from another window doesn't have to wait
 * up to 30s for fresh data.
 */
export function QueueStatsBanner({
  initialStats,
}: {
  initialStats: QueueStats;
}) {
  const [stats, setStats] = useState<QueueStats>(initialStats);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const result = await getQueueStats();
      if (cancelled) return;
      if (result.ok) setStats(result.data);
    }

    const intervalId = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void refresh();
      }
    }, POLL_INTERVAL_MS);

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return (
    <div className="bg-card mb-4 rounded-xl border p-4 text-sm">
      <div className="font-medium">
        {stats.queued} queued · {stats.sentToday} sent today ·{" "}
        {stats.failedToday} failed today
      </div>
      <div className="text-muted-foreground mt-1">
        Next release: {formatNextRelease(stats.nextScheduledFor)} · drain ETA:{" "}
        {formatDrainEta(stats.lastScheduledFor)}
      </div>
    </div>
  );
}

/**
 * Render a "Next release" cell from the absolute timestamp:
 *  - null → "none queued"
 *  - past → "now"
 *  - <60s → "in <N>s"
 *  - else → "in <N>m"
 */
export function formatNextRelease(iso: string | null): string {
  if (iso === null) return "none queued";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "—";
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "now";
  const diffS = Math.round(diffMs / 1000);
  if (diffS < 60) return `in ${diffS}s`;
  const diffM = Math.round(diffS / 60);
  return `in ${diffM}m`;
}

/**
 * Render a drain ETA from the timestamp of the last queued message:
 *  - null → "—"
 *  - past or <1m away → "<1m"
 *  - <1h → "<N>m"
 *  - else → "<H>h <M>m"
 */
export function formatDrainEta(iso: string | null): string {
  if (iso === null) return "—";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "—";
  const diffMs = target - Date.now();
  if (diffMs < 60_000) return "<1m";
  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
