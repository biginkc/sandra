"use client";

import { useEffect, useRef, useState } from "react";

import { getQueueStats, type QueueStats } from "./actions";

const POLL_INTERVAL_MS = 30_000;

function sameStats(a: QueueStats, b: QueueStats): boolean {
  return (
    a.queued === b.queued &&
    a.sentToday === b.sentToday &&
    a.failedToday === b.failedToday &&
    a.nextScheduledFor === b.nextScheduledFor &&
    a.lastScheduledFor === b.lastScheduledFor
  );
}

/**
 * Live queue stats shared by the Outbox tab badge and the stats banner.
 *
 * Seeds from the server-fetched first-paint stats, then polls
 * getQueueStats every 30s while document.visibilityState === "visible";
 * pauses while hidden; fires one immediate refresh when the tab returns
 * to visible so an operator coming back from another window doesn't
 * have to wait up to 30s for fresh data.
 *
 * `enabled: false` (Inbox tab) skips polling entirely — getQueueStats
 * is five DB reads, and an operator parked on Inbox shouldn't generate
 * that load every 30s. First-paint stats stay fresh enough there: the
 * page is force-dynamic, so every navigation/tab switch re-fetches.
 */
export function useQueueStats(
  initialStats: QueueStats,
  { enabled = true }: { enabled?: boolean } = {},
): QueueStats {
  const [stats, setStats] = useState<QueueStats>(initialStats);

  // Adopt fresh server-fetched stats whenever a new RSC render delivers
  // them. The page is force-dynamic, so every navigation (incl. tab
  // switches) re-fetches stats server-side — without this resync, a
  // viewer parked on Inbox (polling disabled) would carry a stale
  // snapshot into the Outbox tab until the next 30s poll. Render-phase
  // derived-state-from-props per React docs. Comparison is by VALUE
  // (the prop is a fresh object literal each render in some callers;
  // identity-tracking would loop), against the last seen prop — not
  // current stats — so a client-side re-render with the old prop never
  // clobbers fresher polled numbers.
  const lastInitialRef = useRef(initialStats);
  // Bumped every time fresh server props are adopted. A poll snapshots
  // the generation when it STARTS; if props arrived while it was in
  // flight, its data predates the server payload and is discarded —
  // otherwise a slow 30s poll resolving after a router.refresh() (every
  // queue action triggers one) would overwrite newer numbers with
  // pre-action ones.
  const generationRef = useRef(0);
  if (!sameStats(lastInitialRef.current, initialStats)) {
    lastInitialRef.current = initialStats;
    generationRef.current += 1;
    setStats(initialStats);
  }

  // Monotonic ordering for the polls themselves: two refreshes can
  // overlap (interval tick + visibilitychange firing close together),
  // and the earlier-started one can resolve last. A result only applies
  // if no later-started refresh has already applied.
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    async function refresh() {
      const generation = generationRef.current;
      const seq = ++requestSeqRef.current;
      const result = await getQueueStats();
      if (cancelled || generation !== generationRef.current) return;
      if (seq <= appliedSeqRef.current) return;
      if (result.ok) {
        appliedSeqRef.current = seq;
        setStats(result.data);
      }
    }

    const intervalId = setInterval(() => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
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
  }, [enabled]);

  return stats;
}
