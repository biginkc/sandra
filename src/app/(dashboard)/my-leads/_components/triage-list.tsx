"use client";

import { Button } from "@/components/ui/button";
import type { TriageSnapshot } from "@/lib/my-leads/call-next";
import { CallNextRowView, type CallNextRowProps } from "./call-next-row";

export type TriageListProps = {
  triage: TriageSnapshot | null;
  loading: boolean;
  error: string | null;
  now: Date;
  canAct: boolean;
  busy?: boolean;
  onLoadMore: () => void;
  onCall: CallNextRowProps["onCall"];
  onCallToday: CallNextRowProps["onCallToday"];
  onNotToday: CallNextRowProps["onNotToday"];
  onDeadNurture: CallNextRowProps["onDeadNurture"];
};

/** "Untouched for 14+ days, no next step": the same row component as the strip, paged. */
export function TriageList({
  triage,
  loading,
  error,
  now,
  canAct,
  busy,
  onLoadMore,
  onCall,
  onCallToday,
  onNotToday,
  onDeadNurture,
}: TriageListProps) {
  return (
    <section
      data-testid="call-next-triage"
      aria-label="Untouched leads with no next step"
      className="mt-3 border-t pt-3"
    >
      <p className="mb-1 text-xs text-muted-foreground">
        {triage
          ? `${triage.totalCount} lead${triage.totalCount === 1 ? "" : "s"} untouched for 14+ days with no next step`
          : "Loading untouched leads…"}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {triage && triage.rows.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">Nothing to triage.</p>
      )}
      {triage && triage.rows.length > 0 && (
        <ul>
          {triage.rows.map((entry) => (
            <CallNextRowView
              key={entry.propertyId}
              item={{
                propertyId: entry.propertyId,
                reason: "longest_since_touch",
                reasonAt: entry.lastTouchAt,
                row: entry.row,
              }}
              now={now}
              canAct={canAct}
              busy={busy}
              onCall={onCall}
              onCallToday={onCallToday}
              onNotToday={onNotToday}
              onDeadNurture={onDeadNurture}
            />
          ))}
        </ul>
      )}
      {triage?.cursor && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2"
          disabled={loading}
          data-testid="call-next-triage-more"
          onClick={onLoadMore}
        >
          {loading ? "Loading…" : "Load more"}
        </Button>
      )}
    </section>
  );
}
