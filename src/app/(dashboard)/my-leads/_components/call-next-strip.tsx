"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type {
  CallNextExcluded,
  CallNextRow,
  TriageSnapshot,
} from "@/lib/my-leads/call-next";
import { CallNextRowView } from "./call-next-row";
import { TriageList } from "./triage-list";
import type { MyLeadsStripProps } from "./types";

/**
 * The ranked "Call next" strip: a computed view above the five sections. It never moves a lead
 * between sections; every action goes through the same handlers the sections use.
 */
export function CallNextStrip({
  rows,
  excluded,
  hiddenCount,
  snapshotAt,
  canAct,
  busyPropertyId = null,
  error = null,
  triageOpen,
  triage,
  triageLoading,
  triageError,
  onToggleTriage,
  onLoadMoreTriage,
  onCall,
  onCallToday,
  onNotToday,
  onDeadNurture,
}: MyLeadsStripProps) {
  const [excludedOpen, setExcludedOpen] = useState(false);
  const now = new Date(snapshotAt);
  return (
    <section
      data-testid="call-next-strip"
      aria-label="Call next"
      className="mb-6 rounded-lg border p-4"
    >
      <header className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="text-base font-bold">Call next</h2>
        <p className="text-xs text-muted-foreground" data-testid="call-next-count">
          {`${rows.length} shown`}
        </p>
        {hiddenCount > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="call-next-hidden">
            {`${hiddenCount} hidden today`}
          </p>
        )}
        {excluded.length > 0 && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={excludedOpen}
            data-testid="call-next-excluded-toggle"
            onClick={() => setExcludedOpen((open) => !open)}
          >
            {`${excluded.length} need a phone number`}
          </Button>
        )}
        <Button
          type="button"
          size="xs"
          variant={triageOpen ? "default" : "outline"}
          aria-pressed={triageOpen}
          className="ml-auto"
          data-testid="call-next-triage-chip"
          onClick={onToggleTriage}
        >
          No next step, untouched 14+ days
        </Button>
      </header>
      {error && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {excludedOpen && excluded.length > 0 && (
        <ul data-testid="call-next-excluded" className="mb-2 space-y-0.5 text-xs text-muted-foreground">
          {excluded.map((entry: CallNextExcluded) => (
            <li key={entry.propertyId}>
              {entry.address}
              {entry.reason === "contact_dnc" ? " · do not contact" : " · no phone number"}
            </li>
          ))}
        </ul>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody needs a call right now.</p>
      ) : (
        <ol>
          {rows.map((item: CallNextRow) => (
            <CallNextRowView
              key={item.propertyId}
              item={item}
              now={now}
              canAct={canAct}
              busy={busyPropertyId === item.propertyId}
              onCall={onCall}
              onCallToday={onCallToday}
              onNotToday={onNotToday}
              onDeadNurture={onDeadNurture}
            />
          ))}
        </ol>
      )}
      {triageOpen && (
        <TriageList
          triage={triage as TriageSnapshot | null}
          loading={triageLoading}
          error={triageError}
          now={now}
          canAct={canAct}
          busy={busyPropertyId !== null}
          onLoadMore={onLoadMoreTriage}
          onCall={onCall}
          onCallToday={onCallToday}
          onNotToday={onNotToday}
          onDeadNurture={onDeadNurture}
        />
      )}
    </section>
  );
}
