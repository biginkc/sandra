"use client";

import { RotateCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { type QueueStats } from "./actions";

/**
 * Stats banner above the Outbox queue table.
 *
 * Renders queued / sentOutToday / failedToday counts, plus the relative
 * "next release" time and humanized drain ETA. Polling lives in
 * useQueueStats, owned by CockpitView, so this banner and the Outbox
 * tab badge always show the same numbers.
 */
export function QueueStatsBanner({
  stats,
  loadFailed = false,
  lastSuccessfulAt = null,
  onRetry,
}: {
  stats: QueueStats;
  loadFailed?: boolean;
  lastSuccessfulAt?: string | null;
  onRetry?: () => void;
}) {
  if (loadFailed) {
    return (
      <div
        className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-950"
        role="status"
        data-testid="queue-stats-failure"
      >
        <p>
          {lastSuccessfulAt
            ? "Queue totals could not be refreshed. The last good totals remain visible below and may be stale; they are not an empty-queue confirmation."
            : "Queue totals could not be refreshed. The queue may still contain work; fallback totals are not an empty-queue confirmation."}
        </p>
        <p className="mt-1 text-xs" data-testid="queue-stats-last-success">
          Last successful refresh:{" "}
          {formatLastSuccessfulRefresh(lastSuccessfulAt)}
        </p>
        {lastSuccessfulAt ? (
          <div className="mt-3 rounded-lg border border-red-200 bg-white p-3 font-medium">
            {stats.queued} queued · {stats.paused} paused · {stats.sentOutToday}{" "}
            sent today · {stats.failedToday} failed today
          </div>
        ) : null}
        {onRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 min-h-11 border-red-300 bg-white text-red-950 hover:bg-red-100"
            onClick={onRetry}
          >
            <RotateCwIcon className="h-4 w-4" aria-hidden="true" />
            Retry totals
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="bg-card mb-4 flex flex-wrap gap-x-5 gap-y-1 rounded-xl border p-4 text-sm">
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

function formatLastSuccessfulRefresh(iso: string | null): string {
  if (!iso) return "server snapshot (exact time unavailable)";
  if (iso === "server-snapshot")
    return "server snapshot (exact time unavailable)";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(time));
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
