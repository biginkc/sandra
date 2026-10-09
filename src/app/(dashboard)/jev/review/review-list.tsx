"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { QueueItemCard } from "../queue-item-card";
import type { JevQueueItem } from "../queries";

type Filter = "all" | "unreviewed_auto_applied" | "pending" | "corrected" | "superseded" | "failed_or_held";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "unreviewed_auto_applied", label: "Unreviewed (auto-applied)" },
  { value: "pending", label: "Pending" },
  { value: "corrected", label: "Corrected" },
  { value: "superseded", label: "Superseded" },
  { value: "failed_or_held", label: "Failed / held" },
];

/**
 * Full audit list with a simple filter — satisfies "allow sampling
 * unreviewed auto decisions for audit" without a dedicated sampling
 * algorithm; a human can filter to unreviewed auto-applied rows and
 * spot-check any of them directly from here. Superseded and failed/held
 * are their own explicit filters, distinct from "unreviewed auto-
 * applied" — a superseded or never-decided row was never a live
 * auto-applied decision in the first place.
 */
export function ReviewList({ items }: { items: JevQueueItem[] }) {
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    switch (filter) {
      case "unreviewed_auto_applied":
        return items.filter(
          (i) =>
            i.source !== "classifier_event" &&
            i.status !== "pending" &&
            i.applicationState !== "superseded" &&
            i.resolvedBy === null &&
            i.humanReviewedAt === null,
        );
      case "pending":
        return items.filter((i) => i.status === "pending");
      case "corrected":
        return items.filter((i) => i.status === "corrected" || i.correctedOutcome);
      case "superseded":
        return items.filter((i) => i.applicationState === "superseded");
      case "failed_or_held":
        return items.filter((i) => i.source === "classifier_event");
      default:
        return items;
    }
  }, [items, filter]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.value}
            type="button"
            size="sm"
            variant="outline"
            className={cn(filter === f.value && "border-primary text-primary")}
            onClick={() => setFilter(f.value)}
            data-testid={`jev-review-filter-${f.value}`}
          >
            {f.label}
          </Button>
        ))}
      </div>
      <div className="rounded-md border">
        {filtered.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No decisions match this filter.</p>
        ) : (
          filtered.map((item) => <QueueItemCard key={`${item.source}:${item.id}`} item={item} />)
        )}
      </div>
    </div>
  );
}
