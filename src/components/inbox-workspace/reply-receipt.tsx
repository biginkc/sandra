"use client";

import { useEffect, useState } from "react";
import type { InboxReplyStatus } from "@/lib/inbox/reply-api-contract";
import styles from "./reply-composer.module.css";

function parseStatus(value: unknown, operationId: string): InboxReplyStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error("The reply receipt could not be verified.");
  const row = value as Record<string, unknown>;
  if (row.operationId !== operationId || typeof row.preparationId !== "string" || typeof row.dispatchComplete !== "boolean" || !Array.isArray(row.items) || !Array.isArray(row.receipts)) throw Error("The reply receipt could not be verified.");
  return value as InboxReplyStatus;
}
function receiptText(state: string): string {
  switch (state) {
    case "delivered": return "Delivered";
    case "provider_accepted": return "Accepted by provider";
    case "delivery_failed": return "Delivery failed";
    case "confirmed_not_submitted":
    case "rejected_unsent": return "Not submitted";
    case "uncertain":
    case "dispatch_started": return "Result not confirmed";
    case "blocked": return "Blocked";
    default: return "Pending";
  }
}

export function InboxReplyReceipt({ operationId }: { operationId: string }) {
  const [status, setStatus] = useState<InboxReplyStatus>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      try {
        const response = await fetch(`/api/inbox/replies/${encodeURIComponent(operationId)}`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw Error("This receipt is temporarily unavailable. Try checking again.");
        const next = parseStatus(await response.json(), operationId);
        if (controller.signal.aborted) return;
        setStatus(next); setError(undefined);
        if (!next.dispatchComplete) timer = setTimeout(() => void check(), 1000);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "This receipt is temporarily unavailable. Try checking again.");
      }
    }
    void check();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [operationId, retry]);

  const uncertain = status?.receipts.some(receipt => ["uncertain", "dispatch_started"].includes(receipt.state));
  return <main className="mx-auto max-w-4xl space-y-6 p-6" data-testid="inbox-reply-receipt">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm text-muted-foreground">Sandra Inbox</p><h1 className="text-2xl font-semibold">Reply receipt</h1><p className="break-all text-xs text-muted-foreground">Operation {operationId}</p></div><a className="rounded border px-3 py-2 text-sm" href="/inbox">← Inbox</a></div>
    <section className={`${styles.receipt} ${uncertain ? styles.uncertain : ""}`} role={error || uncertain ? "alert" : "status"}><strong>{error ? "Receipt unavailable" : uncertain ? "Send result not confirmed" : status?.dispatchComplete ? "Reply operation complete" : "Checking reply operation"}</strong><p>{error ?? (uncertain ? "The provider result is uncertain. Do not resend this reply. Check the conversation and provider receipt manually." : status?.dispatchComplete ? "The server recorded a terminal result for each recipient." : "Checking the durable server receipt…")}</p>{error && <button type="button" className={styles.secondary} onClick={() => setRetry(value => value + 1)}>Check again</button>}</section>
    {status && <section aria-label="Per-recipient results"><h2 className="text-lg font-semibold">Per-recipient results</h2><ul className="mt-3 grid gap-3">{status.items.map(item => { const receipt = status.receipts.find(value => value.itemId === item.id); return <li key={item.id} className="rounded-xl border bg-white p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{item.recipient?.contactName ?? "Excluded recipient"}</p><p className="text-sm text-muted-foreground">{item.recipient?.propertyAddress ?? "Not eligible for this reply"}</p></div><strong className="text-sm">{receiptText(receipt?.state ?? "pending")}</strong></div>{item.recipient && <><div className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><p><span className="block uppercase tracking-wider text-muted-foreground">From</span>{item.recipient.from}</p><p><span className="block uppercase tracking-wider text-muted-foreground">To</span>{item.recipient.to}</p></div><p className="mt-3 whitespace-pre-wrap border-l-2 border-slate-300 pl-3 text-sm">{item.recipient.renderedBody}</p></>}{receipt?.reason && <p className="mt-2 text-sm text-muted-foreground">{receipt.reason}</p>}{receipt && ["uncertain", "dispatch_started"].includes(receipt.state) && <p className="mt-2 text-sm font-medium text-amber-800">Wait for reconciliation. This receipt does not offer a resend.</p>}</li>; })}</ul></section>}
  </main>;
}
