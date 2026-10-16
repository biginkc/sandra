"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { normaBlockReasonText, normaBlockText } from "@/lib/norma/block-copy";
import { formatNormaQueueTime, NORMA_QUEUE_COPY, normaQueuePauseReasonText } from "@/lib/norma/queue/copy";

import { cancelNormaQueueEntries, resumeNormaQueueEntries } from "./actions";

export type NormaQueueRow = {
  id: string;
  propertyId: string;
  address: string;
  status: string;
  pauseReason: string | null;
  blockedReason: string | null;
  nextAttemptAt: string | null;
  displayTz: string | null;
  needsReassignment: boolean;
};

type Filter = "calling" | "due-today" | "parked" | "blocked" | "reassignment";
type EntryResult = { entryId: string; ok: boolean; code?: string };
type BulkResponse = { ok: true; results: EntryResult[] } | { ok: false; code: string };

const COPY = NORMA_QUEUE_COPY.page;

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "calling", label: COPY.filterCalling },
  { key: "due-today", label: COPY.filterDueToday },
  { key: "parked", label: COPY.filterPaused },
  { key: "blocked", label: COPY.filterBlocked },
  { key: "reassignment", label: COPY.filterReassignment },
];

function localDate(date: Date, tz: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return null;
  }
}

/** "Today" is the seller-local date in each row's own display zone, never UTC or one global zone. */
function dueToday(row: NormaQueueRow, now: Date): boolean {
  if (!row.nextAttemptAt || !row.displayTz) return false;
  const next = new Date(row.nextAttemptAt);
  if (Number.isNaN(next.getTime())) return false;
  const a = localDate(next, row.displayTz);
  return a !== null && a === localDate(now, row.displayTz);
}

function matches(row: NormaQueueRow, filter: Filter | null, now: Date): boolean {
  switch (filter) {
    case null: return true;
    case "calling": return row.status === "calling";
    case "due-today": return dueToday(row, now);
    case "parked": return row.status === "paused";
    case "blocked": return row.blockedReason !== null;
    case "reassignment": return row.needsReassignment;
  }
}

export function NormaQueueTable({ rows, todayCount, dailyCap, heldSlots }: {
  rows: NormaQueueRow[];
  todayCount: number;
  dailyCap: number;
  heldSlots: number;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, EntryResult>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [pending, startTransition] = useTransition();

  const now = new Date();
  const visible = rows.filter((row) => matches(row, filter, now));
  const selectedVisible = visible.filter((row) => selected.has(row.id));
  const allSelected = visible.length > 0 && selectedVisible.length === visible.length;

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function bulk(fn: (ids: string[]) => Promise<BulkResponse>) {
    if (pending || selectedVisible.length === 0) return;
    const ids = selectedVisible.map((row) => row.id);
    setError(null);
    setResults(new Map());
    startTransition(async () => {
      let response: BulkResponse;
      try {
        response = await fn(ids);
      } catch {
        response = { ok: false, code: "error" };
      }
      if (!response.ok) {
        setError(normaBlockText({ code: response.code === "unauthenticated" ? "unauthenticated" : "error" }));
        return;
      }
      setResults(new Map(response.results.map((result) => [result.entryId, result])));
      router.refresh();
    });
  }

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
      <p data-testid="norma-queue-today-cap">{COPY.placed(todayCount, dailyCap)}</p>
      {heldSlots > 0 ? <p data-testid="norma-queue-held-slots">{COPY.heldSlots(heldSlots)}</p> : null}
    </div>

    <div className="flex flex-wrap items-center gap-2">
      {FILTERS.map(({ key, label }) => <Button key={key} type="button" size="sm" variant={filter === key ? "default" : "outline"} aria-pressed={filter === key} data-testid={`norma-queue-filter-${key}`} onClick={() => setFilter(filter === key ? null : key)}>{label}</Button>)}
      <span className="flex-1" />
      <Button type="button" size="sm" variant="outline" data-testid="norma-queue-bulk-resume" disabled={pending || selectedVisible.length === 0} onClick={() => bulk(resumeNormaQueueEntries)}>{NORMA_QUEUE_COPY.chip.resume}</Button>
      <Button type="button" size="sm" variant="outline" data-testid="norma-queue-bulk-cancel" disabled={pending || selectedVisible.length === 0} onClick={() => setConfirmingCancel(true)}>{NORMA_QUEUE_COPY.chip.cancel}</Button>
      <Dialog open={confirmingCancel} onOpenChange={(next) => { if (!pending) setConfirmingCancel(next); }}>
        <DialogContent data-testid="norma-queue-bulk-cancel-dialog">
          <DialogHeader><DialogTitle>{NORMA_QUEUE_COPY.chip.cancelBulkPrompt}</DialogTitle></DialogHeader>
          <Button type="button" size="sm" data-testid="norma-queue-bulk-cancel-confirm" disabled={pending} onClick={() => { setConfirmingCancel(false); bulk(cancelNormaQueueEntries); }}>{NORMA_QUEUE_COPY.chip.cancel}</Button>
        </DialogContent>
      </Dialog>
    </div>
    {error ? <p role="alert" data-testid="norma-queue-bulk-error" className="text-destructive text-sm">{error}</p> : null}

    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b">
          <th className="w-8 py-2"><input type="checkbox" aria-label="Select all" data-testid="norma-queue-select-all" checked={allSelected} onChange={() => setSelected((previous) => {
            const next = new Set(previous);
            if (allSelected) visible.forEach((row) => next.delete(row.id));
            else visible.forEach((row) => next.add(row.id));
            return next;
          })} /></th>
          <th className="py-2" />
          <th className="py-2" />
          <th className="py-2" />
          <th className="py-2" />
        </tr>
      </thead>
      <tbody>
        {visible.map((row) => {
          const time = formatNormaQueueTime(row.nextAttemptAt, row.displayTz);
          const reason = row.blockedReason ? normaBlockReasonText(row.blockedReason) : normaQueuePauseReasonText(row.pauseReason);
          const result = results.get(row.id);
          return <tr key={row.id} className="border-b" data-testid={`norma-queue-row-${row.id}`} data-status={row.status}>
            <td className="py-2"><input type="checkbox" aria-label={`Select ${row.address}`} data-testid={`norma-queue-select-${row.id}`} checked={selected.has(row.id)} onChange={() => toggle(row.id)} /></td>
            <td className="py-2"><a className="underline" href={`/leads/${row.propertyId}`}>{row.address}</a></td>
            <td className="py-2"><span>{NORMA_QUEUE_COPY.chip.status[row.status] ?? row.status}</span>{reason ? <span className="text-muted-foreground"> · {reason}</span> : null}{row.needsReassignment ? <span className="text-muted-foreground"> · {NORMA_QUEUE_COPY.chip.needsReassignment}</span> : null}</td>
            <td className="py-2" data-testid="norma-queue-next-attempt">{time ? NORMA_QUEUE_COPY.chip.nextCall(time) : null}</td>
            <td className="py-2">{result ? <span data-testid={`norma-queue-result-${row.id}`} data-ok={result.ok ? "true" : "false"} aria-hidden>{result.ok ? "✓" : "✕"}</span> : null}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
