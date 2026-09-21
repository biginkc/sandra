"use client";

import { useState } from "react";

import { QueueItemCard } from "../queue-item-card";
import type { JevQueueItem } from "../queries";

/**
 * Client-side optimistic removal: once an item is confirmed/corrected it
 * drops out of the Needs-a-decision list immediately rather than waiting
 * for a full page reload, even though the server action's
 * revalidatePath will also refresh this route on next navigation.
 */
export function NeedsDecisionList({ initialItems }: { initialItems: JevQueueItem[] }) {
  const [items, setItems] = useState(initialItems);

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
