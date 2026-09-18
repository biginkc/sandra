"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Target = { kind: "conversation" | "unknown_sender_group"; id: string };
type MetadataItem = {
  id: string;
  target: Target;
  propertyId: string | null;
  exclusion: string | null;
  stepIds: readonly string[];
  state: string;
  code: string | null;
};
type MetadataStatus = {
  operationId: string;
  acceptedAt: string;
  completed: boolean;
  result: string | null;
  items: readonly MetadataItem[];
  steps: readonly { id: string; action: string; state: string; code: string | null; changed: boolean | null }[];
};
type ReplyItem = {
  id: string;
  target: Target;
  exclusion: string | null;
  recipient: null | { contactName: string; propertyAddress: string; to: string; renderedBody: string };
};
type ReplyReceipt = { itemId: string; state: string; reason: string | null };
type ReplyStatus = {
  operationId: string;
  preparationId: string;
  dispatchComplete: boolean;
  items: readonly ReplyItem[];
  receipts: readonly ReplyReceipt[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class ReceiptAccessError extends Error {}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function target(value: unknown): Target | null {
  const row = object(value);
  return row && (row.kind === "conversation" || row.kind === "unknown_sender_group") && typeof row.id === "string" && row.id.length > 0 && row.id.length <= 256
    ? { kind: row.kind, id: row.id } : null;
}

function parseMetadata(value: unknown, operationId: string): MetadataStatus | null {
  const row = object(value);
  if (!row || row.operationId !== operationId || typeof row.acceptedAt !== "string" || typeof row.completed !== "boolean" || (row.result !== null && typeof row.result !== "string") || !Array.isArray(row.items) || row.items.length > 500 || !Array.isArray(row.steps) || row.steps.length > 1000) return null;
  const items = row.items.map(raw => {
    const item = object(raw);
    const itemTarget = item && target(item.target);
    return item && typeof item.id === "string" && itemTarget && (item.propertyId === null || typeof item.propertyId === "string") && (item.exclusion === null || typeof item.exclusion === "string") && Array.isArray(item.stepIds) && item.stepIds.length <= 20 && item.stepIds.every(id => typeof id === "string") && typeof item.state === "string" && (item.code === null || typeof item.code === "string")
      ? { id: item.id, target: itemTarget, propertyId: item.propertyId as string | null, exclusion: item.exclusion as string | null, stepIds: item.stepIds as string[], state: item.state, code: item.code as string | null } : null;
  });
  const steps = row.steps.map(raw => {
    const step = object(raw);
    return step && typeof step.id === "string" && typeof step.action === "string" && typeof step.state === "string" && (step.code === null || typeof step.code === "string") && (step.changed === null || typeof step.changed === "boolean")
      ? { id: step.id, action: step.action, state: step.state, code: step.code as string | null, changed: step.changed as boolean | null } : null;
  });
  return items.every(Boolean) && steps.every(Boolean) ? { operationId, acceptedAt: row.acceptedAt, completed: row.completed, result: row.result as string | null, items: items as MetadataItem[], steps: steps as MetadataStatus["steps"] } : null;
}

function parseReply(value: unknown, operationId: string): ReplyStatus | null {
  const row = object(value);
  if (!row || row.operationId !== operationId || typeof row.preparationId !== "string" || !UUID.test(row.preparationId) || typeof row.dispatchComplete !== "boolean" || !Array.isArray(row.items) || row.items.length > 500 || !Array.isArray(row.receipts) || row.receipts.length > 500) return null;
  const items = row.items.map(raw => {
    const item = object(raw);
    const itemTarget = item && target(item.target);
    const recipient = item && object(item.recipient);
    const parsedRecipient = recipient && typeof recipient.contactName === "string" && typeof recipient.propertyAddress === "string" && typeof recipient.to === "string" && typeof recipient.renderedBody === "string"
      ? { contactName: recipient.contactName, propertyAddress: recipient.propertyAddress, to: recipient.to, renderedBody: recipient.renderedBody } : null;
    return item && typeof item.id === "string" && itemTarget && (item.exclusion === null || typeof item.exclusion === "string") && (item.recipient === null || parsedRecipient)
      ? { id: item.id, target: itemTarget, exclusion: item.exclusion as string | null, recipient: parsedRecipient } : null;
  });
  const receipts = row.receipts.map(raw => {
    const receipt = object(raw);
    return receipt && typeof receipt.itemId === "string" && typeof receipt.state === "string" && (receipt.reason === null || typeof receipt.reason === "string")
      ? { itemId: receipt.itemId, state: receipt.state, reason: receipt.reason as string | null } : null;
  });
  return items.every(Boolean) && receipts.every(Boolean) ? { operationId, preparationId: row.preparationId, dispatchComplete: row.dispatchComplete, items: items as ReplyItem[], receipts: receipts as ReplyReceipt[] } : null;
}

function labelTarget(value: Target): string {
  return `${value.kind === "conversation" ? "Conversation" : "Unknown sender group"} ${value.id}`;
}

function metadataOutcome(item: MetadataItem): string {
  if (item.exclusion) return `Excluded: ${item.exclusion}`;
  if (item.state === "conflicted") return "Conflict: the record changed before completion";
  if (item.state === "blocked") return "Blocked: needs attention";
  return item.state;
}

function replyOutcome(item: ReplyItem, receipt: ReplyReceipt | undefined): string {
  if (item.exclusion) return `Excluded: ${item.exclusion}`;
  if (!receipt) return "Waiting for dispatch receipt";
  return receipt.reason ? `${receipt.state}: ${receipt.reason}` : receipt.state;
}

function statusLabel(metadata: MetadataStatus | null, reply: ReplyStatus | null): string {
  if (metadata) return metadata.completed ? `Action ${metadata.result ?? "finished"}` : "Action accepted; checking durable progress…";
  if (reply) return reply.dispatchComplete ? "Reply dispatch complete" : "Reply accepted; checking durable progress…";
  return "Checking durable progress…";
}

export function InboxOperationReceipt({ operationId, kind }: { operationId: string; kind: "metadata" | "reply" }) {
  const [metadata, setMetadata] = useState<MetadataStatus | null>(null);
  const [reply, setReply] = useState<ReplyStatus | null>(null);
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setMetadata(null);
    setReply(null);
    setError(undefined);
    setLoading(true);
  }, [kind, operationId]);

  const check = useCallback(async (signal: AbortSignal) => {
    const endpoint = kind === "reply" ? `/api/inbox/replies/${encodeURIComponent(operationId)}` : `/api/inbox/operations/${encodeURIComponent(operationId)}`;
    const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    if (response.status === 401 || response.status === 403) throw new ReceiptAccessError("This receipt is unavailable for the current account.");
    if (!response.ok) throw new Error("This receipt is temporarily unavailable. Try checking again.");
    const value = await response.json() as unknown;
    if (signal.aborted) return false;
    const parsed = kind === "reply" ? parseReply(value, operationId) : parseMetadata(value, operationId);
    if (!parsed) throw new Error("The receipt response could not be verified.");
    if (kind === "reply") setReply(parsed as ReplyStatus);
    else setMetadata(parsed as MetadataStatus);
    setError(undefined);
    return kind === "reply" ? (parsed as ReplyStatus).dispatchComplete : (parsed as MetadataStatus).completed;
  }, [kind, operationId]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let polls = 0;
    let failures = 0;
    async function poll() {
      if (cancelled) return;
      setLoading(true);
      try {
        const complete = await check(controller.signal);
        if (cancelled || complete) return;
        polls++;
        if (polls >= 600) { setError("This receipt is still running. Check again to refresh its progress."); return; }
        failures = 0;
        timer = setTimeout(() => void poll(), 1000);
      } catch (cause) {
        if (!cancelled) {
          if (cause instanceof ReceiptAccessError) {
            setMetadata(null);
            setReply(null);
            setError(cause.message);
            return;
          }
          setError(cause instanceof Error ? cause.message : "Receipt progress is unavailable.");
          failures++;
          if (failures < 5) timer = setTimeout(() => void poll(), 2000);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void poll();
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [check, retry]);

  const current = metadata ?? reply;
  const receiptMap = useMemo(() => new Map((reply?.receipts ?? []).map(receipt => [receipt.itemId, receipt])), [reply?.receipts]);
  const terminal = metadata?.completed || reply?.dispatchComplete;
  return <main className="mx-auto max-w-4xl space-y-6 p-6" data-testid="inbox-operation-receipt">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-sm text-muted-foreground">Sandra Inbox</p><h1 className="text-2xl font-semibold">{kind === "reply" ? "Reply receipt" : "Action receipt"}</h1><p className="break-all text-xs text-muted-foreground">Operation {operationId}</p></div>
      <a className="rounded border px-3 py-2 text-sm" href="/messages">Back to Messages</a>
    </div>
    <section aria-label="Receipt status" className="rounded border p-4">
      <p role={error ? "alert" : "status"}>{error ?? statusLabel(metadata, reply)}</p>
      {loading && !current && <p className="text-sm text-muted-foreground">Loading the server receipt…</p>}
      {error && <button type="button" className="mt-3 rounded border px-3 py-2 text-sm" onClick={() => setRetry(value => value + 1)}>Check again</button>}
      {terminal && <p className="mt-2 text-sm text-muted-foreground">This receipt is terminal. No send retry is offered here.</p>}
    </section>
    {metadata && <section aria-label="Action results" className="space-y-3"><h2 className="text-lg font-semibold">Per-target results</h2><p className="text-sm">{metadata.items.filter(item => !item.exclusion && ["succeeded", "completed"].includes(item.state)).length} succeeded · {metadata.items.filter(item => item.exclusion || ["failed", "conflicted", "blocked"].includes(item.state)).length} need attention · {metadata.items.filter(item => item.exclusion).length} excluded</p><ul className="space-y-2">{metadata.items.map(item => <li key={item.id} className="rounded border p-3"><p className="font-medium">{labelTarget(item.target)}</p><p className="text-sm">{metadataOutcome(item)}{item.code ? ` · ${item.code}` : ""}</p></li>)}</ul></section>}
    {reply && <section aria-label="Reply results" className="space-y-3"><h2 className="text-lg font-semibold">Per-recipient results</h2><p className="text-sm">{reply.receipts.filter(receipt => ["provider_accepted", "delivered"].includes(receipt.state)).length} accepted or delivered · {reply.receipts.filter(receipt => ["uncertain", "dispatch_started"].includes(receipt.state)).length} uncertain or pending · {reply.receipts.filter(receipt => ["delivery_failed", "rejected_unsent", "confirmed_not_submitted"].includes(receipt.state)).length} failed or not submitted</p><ul className="space-y-2">{reply.items.map(item => { const receipt = receiptMap.get(item.id); const uncertain = receipt && ["uncertain", "dispatch_started"].includes(receipt.state); return <li key={item.id} className={`rounded border p-3 ${uncertain ? "border-amber-400 bg-amber-50" : ""}`}><p className="font-medium">{item.recipient?.contactName ?? labelTarget(item.target)}</p><p className="text-sm">{item.recipient?.propertyAddress ?? labelTarget(item.target)}</p><p className="text-sm">{replyOutcome(item, receipt)}</p>{uncertain && <p className="mt-1 text-sm font-medium text-amber-900">Uncertain send: wait for provider reconciliation. This receipt will not retry it automatically.</p>}</li>; })}</ul></section>}
  </main>;
}
