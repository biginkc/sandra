"use client";

import { useEffect, useState } from "react";
import type { InboxReplyStatus } from "@/lib/inbox/reply-api-contract";
import styles from "./reply-composer.module.css";
import {
  classifyReceipt,
  receiptItemViews,
  receiptPollDelay,
  receiptRollup,
  receiptRollupCopy,
  type ReceiptClassification,
  type ReceiptPollTracker,
} from "./reply-receipt-policy";

function parseStatus(value: unknown, operationId: string): InboxReplyStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error("The reply receipt could not be verified.");
  const row = value as Record<string, unknown>;
  if (row.operationId !== operationId || typeof row.preparationId !== "string" || typeof row.dispatchComplete !== "boolean" || !Array.isArray(row.items) || !Array.isArray(row.receipts)) throw Error("The reply receipt could not be verified.");
  return value as InboxReplyStatus;
}

type ReplyReceiptViewProps = {
  operationId: string;
  fetcher?: typeof fetch;
  initialTracker?: ReceiptPollTracker;
  initialFingerprint?: string;
  initialTrackerAgeMs?: number;
};

function ReplyReceiptView({ operationId, fetcher = fetch, initialTracker, initialFingerprint, initialTrackerAgeMs = 0 }: ReplyReceiptViewProps) {
  const [status, setStatus] = useState<InboxReplyStatus>();
  const [error, setError] = useState<string>();
  const [classification, setClassification] = useState<ReceiptClassification>("in_flight");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tracker: ReceiptPollTracker = initialTracker ?? (initialFingerprint
      ? { fingerprint: initialFingerprint, unchangedSince: Date.now() - initialTrackerAgeMs }
      : { unchangedSince: Date.now() });

    function stopAtBound(nextStatus?: InboxReplyStatus) {
      if (nextStatus) setStatus(nextStatus);
      setError(undefined);
      setClassification("not_confirmed");
    }

    function schedule(attempt: number) {
      if (timer) clearTimeout(timer);
      const delay = receiptPollDelay(attempt, tracker.unchangedSince);
      if (delay === null) {
        stopAtBound();
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        void check(attempt + 1);
      }, delay);
    }

    async function check(attempt = 0) {
      try {
        const response = await fetcher(`/api/inbox/replies/${encodeURIComponent(operationId)}`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw Error("This receipt is temporarily unavailable. Try checking again.");
        const next = parseStatus(await response.json(), operationId);
        if (controller.signal.aborted) return;
        const decision = classifyReceipt(next, tracker);
        tracker = { fingerprint: decision.fingerprint, unchangedSince: decision.unchangedSince };
        setStatus(next);
        setError(undefined);
        setClassification(decision.classification);
        if (decision.classification === "in_flight") schedule(attempt);
        else if (decision.classification === "not_confirmed") stopAtBound(next);
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (receiptPollDelay(attempt, tracker.unchangedSince) === null) stopAtBound();
          else {
            setError(cause instanceof Error ? cause.message : "This receipt is temporarily unavailable. Try checking again.");
            schedule(attempt);
          }
        }
      }
    }

    void check();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [fetcher, initialFingerprint, initialTracker, initialTrackerAgeMs, operationId, retry]);

  const timedOut = classification === "not_confirmed";
  const rollup = status ? receiptRollup(status, timedOut) : null;
  const terminal = classification === "terminal";
  const notConfirmed = classification === "not_confirmed";
  const stillSending = !error && !!rollup?.keepPolling;
  const hasNotSent = !!rollup && rollup.counts.blocked + rollup.counts.failed > 0;
  const alert = !!error || !!rollup?.hasServerNotConfirmed || !!rollup?.hasTimeoutNotConfirmed || hasNotSent || notConfirmed;
  const headline = rollup?.keepPolling && !rollup.hasServerNotConfirmed && !rollup.hasTimeoutNotConfirmed ? "Still sending…" : rollup?.headline;
  const rollupWarning = !!rollup && (rollup.hasServerNotConfirmed || rollup.hasTimeoutNotConfirmed || hasNotSent);
  const receiptClass = `${styles.receipt} ${stillSending && !rollupWarning ? styles.receiptPending : ""} ${notConfirmed || rollupWarning ? styles.uncertain : ""}`;

  return <main className="mx-auto max-w-4xl space-y-6 p-6" data-testid="inbox-reply-receipt">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm text-muted-foreground">Sandra Inbox</p><h1 className="text-2xl font-semibold">Reply receipt</h1><p className="break-all text-xs text-muted-foreground">Operation {operationId}</p></div><a className="rounded border px-3 py-2 text-sm" href="/inbox">← Inbox</a></div>
    <section className={receiptClass} role={alert ? "alert" : "status"}>
      <strong>{error ? "Receipt unavailable" : headline ?? (terminal ? "Reply operation complete" : "Checking reply operation")}</strong>
      <p>{error ?? (rollup ? receiptRollupCopy(rollup) : "Checking the durable server receipt…")}</p>
      {notConfirmed && <button type="button" className={styles.secondary} onClick={() => setRetry(value => value + 1)}>Refresh</button>}
      {error && !notConfirmed && <button type="button" className={styles.secondary} onClick={() => setRetry(value => value + 1)}>Check again</button>}
    </section>
    {status && <section aria-label="Per-recipient results"><h2 className="text-lg font-semibold">Per-recipient results</h2><ul className="mt-3 grid gap-3">{receiptItemViews(status, timedOut).map(row => { const item = status.items.find(value => value.id === row.itemId); return <li key={row.itemId} className="rounded-xl border bg-white p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{item?.recipient?.contactName ?? "Excluded recipient"}</p><p className="text-sm text-muted-foreground">{item?.recipient?.propertyAddress ?? "Not eligible for this reply"}</p></div><div className="text-right"><small className="block text-xs font-semibold text-slate-500">{row.statusLabel}</small><strong className="text-sm">{row.label}</strong></div></div>{item?.recipient && <><div className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><p><span className="block uppercase tracking-wider text-muted-foreground">From</span>{item.recipient.from}</p><p><span className="block uppercase tracking-wider text-muted-foreground">To</span>{item.recipient.to}</p></div><p className="mt-3 whitespace-pre-wrap border-l-2 border-slate-300 pl-3 text-sm">{item.recipient.renderedBody}</p></>}{row.reason && <p className="mt-2 text-sm text-muted-foreground">Reason: {row.reason}</p>}{row.keepPolling && <p className="mt-2 text-sm font-medium text-amber-800">Wait for reconciliation. This receipt does not offer a resend.</p>}</li>; })}</ul></section>}
  </main>;
}

export function InboxReplyReceipt({ operationId }: { operationId: string }) {
  return <ReplyReceiptView operationId={operationId} />;
}

/** Preview-only adapter; production receipt links use InboxReplyReceipt above. */
export function PreviewInboxReplyReceipt({ operationId, fetcher, initialTracker, initialFingerprint, initialTrackerAgeMs }: ReplyReceiptViewProps) {
  return <ReplyReceiptView operationId={operationId} fetcher={fetcher} initialTracker={initialTracker} initialFingerprint={initialFingerprint} initialTrackerAgeMs={initialTrackerAgeMs} />;
}
