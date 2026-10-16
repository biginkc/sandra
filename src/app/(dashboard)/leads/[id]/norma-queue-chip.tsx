"use client";

import { ListPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { normaBlockReasonText, normaBlockText } from "@/lib/norma/block-copy";
import { formatNormaQueueTime, NORMA_QUEUE_COPY, normaQueuePauseReasonText } from "@/lib/norma/queue/copy";

import { addToNormaQueue, cancelNormaQueueEntry, pauseNormaQueueEntry, resumeNormaQueueEntry } from "./norma-queue-actions";

export type NormaQueueChipEntry = {
  id: string;
  status: string;
  pauseReason: string | null;
  nextAttemptAt: string | null;
  displayTz: string | null;
  attemptCount: number;
};

type Result = { ok: true } | { ok: false; code: string; reason?: string };
type Notice = { tone: "error" | "success"; text: string };

const COPY = NORMA_QUEUE_COPY.chip;
const LIVE = new Set(["queued", "calling", "paused"]);

export function NormaQueueChip({ propertyId, entry, reassignment = null, pausedByName = null }: {
  propertyId: string;
  entry: NormaQueueChipEntry | null;
  reassignment?: { kind: string; status: string } | null;
  pausedByName?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const live = entry !== null && LIVE.has(entry.status);

  function run(fn: () => Promise<Result>, afterOk?: () => void) {
    if (pending) return;
    setNotice(null);
    startTransition(async () => {
      let result: Result;
      try {
        result = await fn();
      } catch {
        result = { ok: false, code: "error" };
      }
      if (result.ok) {
        afterOk?.();
        router.refresh();
        return;
      }
      const text = result.code === "blocked" && result.reason
        ? normaBlockReasonText(result.reason)
        : result.code === "refused" && result.reason === "open_request"
          ? normaBlockText({ code: "in_flight" })
          : result.code === "refused" && result.reason === "unknown_state"
            ? COPY.pauseReason.unknown_state
            : normaBlockText({ code: "error" });
      setNotice({ tone: "error", text });
    });
  }

  const nextTime = entry ? formatNormaQueueTime(entry.nextAttemptAt, entry.displayTz) : null;
  const pauseText = entry?.status === "paused" ? normaQueuePauseReasonText(entry.pauseReason, pausedByName) : null;

  return <div className="inline-flex flex-wrap items-center gap-2" data-testid="norma-queue-wrapper">
    {entry ? <div
      data-testid="norma-queue-chip"
      data-status={entry.status}
      data-pause-reason={entry.pauseReason ?? undefined}
      className="inline-flex flex-wrap items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium"
    >
      <span>{COPY.status[entry.status] ?? entry.status}</span>
      {pauseText ? <span data-testid="norma-queue-pause-reason" className="text-muted-foreground">{pauseText}</span> : null}
      {live && entry.status === "queued" && nextTime ? <span data-testid="norma-queue-next-attempt" className="text-muted-foreground">{COPY.nextCall(nextTime)}</span> : null}
      {live ? <span data-testid="norma-queue-attempts" className="text-muted-foreground">{COPY.attempts(entry.attemptCount)}</span> : null}
    </div> : null}
    {reassignment ? <span data-testid="norma-queue-reassignment" data-kind={reassignment.kind} className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900">{COPY.needsReassignment}</span> : null}
    {live && entry ? <>
      {entry.status === "paused"
        ? <Button type="button" size="sm" variant="outline" data-testid="norma-queue-resume" disabled={pending} onClick={() => run(() => resumeNormaQueueEntry(entry.id))}>{COPY.resume}</Button>
        : <Button type="button" size="sm" variant="outline" data-testid="norma-queue-pause" disabled={pending} onClick={() => run(() => pauseNormaQueueEntry(entry.id))}>{COPY.pause}</Button>}
      <Button type="button" size="sm" variant="outline" data-testid="norma-queue-cancel" disabled={pending} onClick={() => setConfirmingCancel(true)}>{COPY.cancel}</Button>
      <Dialog open={confirmingCancel} onOpenChange={(next) => { if (!pending) setConfirmingCancel(next); }}>
        <DialogContent data-testid="norma-queue-cancel-dialog">
          <DialogHeader><DialogTitle>{COPY.cancelPrompt}</DialogTitle></DialogHeader>
          <Button type="button" size="sm" data-testid="norma-queue-cancel-confirm" disabled={pending} onClick={() => { setConfirmingCancel(false); run(() => cancelNormaQueueEntry(entry.id)); }}>{COPY.cancel}</Button>
        </DialogContent>
      </Dialog>
    </> : <Button type="button" size="sm" variant="outline" data-testid="norma-queue-add" disabled={pending} onClick={() => run(() => addToNormaQueue(propertyId, null))}>
      <ListPlus className="h-3.5 w-3.5" />{COPY.add}
    </Button>}
    {notice ? <p role="alert" data-testid="norma-queue-notice" data-tone={notice.tone} className="text-destructive w-full text-xs">{notice.text}</p> : null}
  </div>;
}
