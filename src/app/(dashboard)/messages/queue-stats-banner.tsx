"use client";

import { type QueueStats } from "./actions";

/**
 * Stats banner above the Outbox queue table.
 *
 * Renders queued / sentOutToday / failedToday counts, plus the relative
 * "next release" time and humanized drain ETA. Polling lives in
 * useQueueStats, owned by CockpitView, so this banner and the Outbox
 * tab badge always show the same numbers.
 */
export function QueueStatsBanner({ stats }: { stats: QueueStats }) {
  return (
    <div className="bg-card mb-4 rounded-xl border p-4 text-sm">
      <div className="font-medium">
        {stats.queued} queued
        {stats.paused > 0 ? ` · ${stats.paused} paused` : ""} ·{" "}
        {stats.sentOutToday} sent out today · {stats.failedToday} failed today
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
