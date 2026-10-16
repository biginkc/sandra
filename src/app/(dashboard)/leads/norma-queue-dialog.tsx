"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { normaBlockReasonText, normaBlockText } from "@/lib/norma/block-copy";
import { NORMA_QUEUE_COPY } from "@/lib/norma/queue/copy";

import { queueNormaCalls } from "./queue-norma-actions";

type Lead = { id: string; address: string };
type Row = { propertyId: string; result: string; reason?: string | null };
type Outcome =
  | { ok: true; queueEnabled: boolean; results: Row[] }
  | { ok: false; code: string };

const COPY = NORMA_QUEUE_COPY.dialog;

function reasonText(row: Row): string {
  switch (row.result) {
    case "blocked":
      return normaBlockReasonText(row.reason ?? "eligibility_check_failed");
    case "open_request":
      return normaBlockText({ code: "in_flight" });
    case "unknown_state":
      return NORMA_QUEUE_COPY.chip.pauseReason.unknown_state;
    case "not_found":
      return normaBlockText({ code: "lead_not_found" });
    default:
      return normaBlockText({ code: "error" });
  }
}

export function NormaQueueDialog({ open, leads, onClose, onComplete, capacity }: {
  open: boolean;
  leads: Lead[];
  onClose: () => void;
  onComplete: () => void;
  /** Optional: shown as the capacity hint when the caller knows the daily cap and how many calls are already due. */
  capacity?: { cap: number; due: number };
}) {
  const [context, setContext] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Extract<Outcome, { ok: true }> | null>(null);
  const inFlight = useRef(false);

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setError(null);
    try {
      const result = (await queueNormaCalls(leads.map((lead) => lead.id), context.trim() || null)) as Outcome;
      if (!result.ok) {
        setError(normaBlockText({ code: result.code === "unauthenticated" ? "unauthenticated" : "error" }));
        return;
      }
      setOutcome(result);
      onComplete();
    } catch {
      setError(normaBlockText({ code: "error" }));
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  }

  const addressOf = (id: string) => leads.find((lead) => lead.id === id)?.address ?? id;
  const rows = outcome?.results ?? [];
  const queued = rows.filter((row) => row.result === "queued");
  const already = rows.filter((row) => row.result === "already_queued");
  const blocked = rows.filter((row) => row.result === "blocked");
  const notQueued = rows.filter((row) => !["queued", "already_queued", "blocked"].includes(row.result));

  function group(key: string, label: string, items: Row[], withReason: boolean) {
    if (items.length === 0) return null;
    return <div key={key} data-testid={`norma-queue-group-${key}`} data-count={items.length} className="space-y-1">
      <p className="font-medium">{label}</p>
      <ul className="text-muted-foreground list-disc pl-5">
        {items.map((row) => <li key={row.propertyId}>
          <span>{addressOf(row.propertyId)}</span>
          {withReason ? <span data-testid={`norma-queue-reason-${row.propertyId}`} data-reason={row.result === "blocked" ? (row.reason ?? "") : row.result}>{" "}{reasonText(row)}</span> : null}
        </li>)}
      </ul>
    </div>;
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!next && !running) { setOutcome(null); setError(null); onClose(); } }}>
    <DialogContent showCloseButton={!running} className="flex max-h-[calc(100dvh-2rem)] grid-rows-none flex-col overflow-hidden sm:max-w-lg">
      <DialogHeader><DialogTitle>{"Queue "}<span data-testid="norma-queue-count">{leads.length}</span>{" leads for Norma"}</DialogTitle></DialogHeader>
      {!outcome ? <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto text-sm">
        <p>{COPY.hours}</p>
        <p>{COPY.retry}</p>
        {capacity ? <p data-testid="norma-queue-capacity">{COPY.capacity(capacity.cap, capacity.due)}</p> : null}
        <label htmlFor="norma-queue-context" className="text-xs font-medium">{COPY.contextLabel}</label>
        <Textarea id="norma-queue-context" data-testid="norma-queue-context" value={context} onChange={(event) => setContext(event.target.value)} maxLength={2000} rows={3} disabled={running} />
        {error ? <p role="alert" data-testid="norma-queue-error" className="text-destructive">{error}</p> : null}
        <Button type="button" size="sm" data-testid="norma-queue-submit" onClick={submit} disabled={running}>{COPY.submit}</Button>
      </div> : <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto text-sm">
        {!outcome.queueEnabled ? <p role="status" data-testid="norma-queue-flag-off" className="text-amber-800">{COPY.switchedOff}</p> : null}
        {group("queued", COPY.queued(queued.length), queued, false)}
        {group("already_queued", COPY.alreadyQueued(already.length), already, false)}
        {group("blocked", COPY.notQueued(blocked.length), blocked, true)}
        {group("not_queued", COPY.notQueued(notQueued.length), notQueued, true)}
        <Button type="button" variant="outline" size="sm" data-testid="norma-queue-done" onClick={() => { setOutcome(null); onClose(); }}>Done</Button>
      </div>}
    </DialogContent>
  </Dialog>;
}
