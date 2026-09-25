"use client";

import { useEffect, useRef, useState } from "react";

import { refetchNeedsDecisionQueue } from "../actions";
import { QueueItemCard } from "../queue-item-card";
import type { JevQueueItem } from "../queries";

/** How often to poll for fresh held decisions while the page stays open.
 *  Root final-review P1 #3: a below-threshold decision must surface
 *  "within minutes" without a manual reload — 30s comfortably satisfies
 *  that without hammering the DB. */
const POLL_INTERVAL_MS = 30_000;

/**
 * Client-side optimistic removal: once an item is confirmed/corrected it
 * drops out of the Needs-a-decision list immediately, rather than
 * waiting for the next poll or a full page reload.
 *
 * Also polls the server periodically and replaces the list with the
 * fresh server truth (root final-review P1 #3) — this both surfaces
 * newly-held decisions that arrived while the page was open, and safely
 * reconciles anything a correction changed elsewhere (e.g. another
 * reviewer, or a newer inbound superseding a row). Keyed by
 * `${source}:${id}`, so React preserves each QueueItemCard's own local
 * state (an open outcome picker, an in-flight action) across a poll
 * refresh instead of remounting it.
 */
export function NeedsDecisionList({ initialItems }: { initialItems: JevQueueItem[] }) {
  const [items, setItems] = useState(initialItems);
  const pollInFlight = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      refetchNeedsDecisionQueue()
        .then((result) => {
          if (!result.error) setItems(result.items);
        })
        .catch(() => {
          // Best-effort: a failed poll just tries again next interval —
          // never replaces a good list with an error state the user
          // didn't ask to see.
        })
        .finally(() => {
          pollInFlight.current = false;
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  if (items.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground" data-testid="jev-needs-decision-empty">
        Nothing needs a decision right now.
      </p>
    );
  }

  return (
    <div>
      {items.map((item) => (
        <QueueItemCard
          key={`${item.source}:${item.id}`}
          item={item}
          onResolved={() => setItems((prev) => prev.filter((i) => i.id !== item.id))}
        />
      ))}
    </div>
  );
}
