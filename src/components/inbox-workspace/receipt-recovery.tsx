"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InboxQueryIdentity } from "@/lib/inbox/workspace-query";
import { parseRecoveryEntries, recoveryStorageKey, type RecoveryEntry, type RecoveryKind } from "./recovery-registry";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Entry = RecoveryEntry & { source: "action" | "saved" | "reply"; id: string; state: "checking" | "pending" | "accepted" | "expired" | "error"; operationId?: string; error?: string };

const prefixes = [
  ["action", "inbox-action-recovery"],
  ["saved", "inbox-saved-action-recovery"],
  ["reply", "inbox-reply-recovery"],
] as const;

function readEntries(identity: InboxQueryIdentity): Entry[] {
  const records: Entry[] = [];
  for (const [source, prefix] of prefixes) {
    const key = recoveryStorageKey(prefix, identity);
    let values: RecoveryEntry[];
    try { values = parseRecoveryEntries(sessionStorage.getItem(key)); } catch { continue; }
    values.forEach((entry, index) => {
      if (!UUID.test(entry.preparationId) || !UUID.test(entry.idempotencyKey)) return;
      const kind: RecoveryKind = source === "action" ? "metadata" : source === "reply" ? "reply" : entry.kind === "reply" ? "reply" : "metadata";
      records.push({ ...entry, kind, source, id: `${source}:${entry.preparationId}:${entry.idempotencyKey}:${index}`, state: "checking" });
    });
  }
  return records;
}

export function InboxReceiptRecovery({ identity }: { identity: InboxQueryIdentity }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const inFlight = useRef(new Set<string>());

  const reload = useCallback(() => { setEntries(readEntries(identity)); setLoaded(true); }, [identity]);
  useEffect(() => { reload(); }, [reload]);

  const removeExpired = useCallback((entry: Entry) => {
    const prefix = prefixes.find(([source]) => source === entry.source)?.[1] ?? "inbox-saved-action-recovery";
    const key = recoveryStorageKey(prefix, identity);
    try {
      const current = parseRecoveryEntries(sessionStorage.getItem(key));
      const remaining = current.filter(value => value.preparationId !== entry.preparationId || value.idempotencyKey !== entry.idempotencyKey);
      if (!remaining.length) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(remaining.length === 1 ? remaining[0] : remaining));
    } catch { /* keep the opaque record if storage becomes unavailable */ }
  }, [identity]);

  const check = useCallback(async (entry: Entry) => {
    setEntries(current => current.map(value => value.id === entry.id ? { ...value, state: "checking", error: undefined } : value));
    try {
      const path = entry.kind === "reply" ? "/api/inbox/replies/recover" : "/api/inbox/operations/recover";
      const response = await fetch(`${path}?preparationId=${encodeURIComponent(entry.preparationId)}&idempotencyKey=${encodeURIComponent(entry.idempotencyKey)}`, { credentials: "same-origin", cache: "no-store", redirect: "error" });
      if (response.status === 401 || response.status === 403) throw new Error("This recovery record is unavailable for the current account.");
      if (!response.ok) throw new Error("Recovery is temporarily unavailable. The original identifiers are retained.");
      const value = await response.json() as Record<string, unknown>;
      if (value.state === "accepted") {
        const operation = value.operation && typeof value.operation === "object" && !Array.isArray(value.operation) ? value.operation as Record<string, unknown> : null;
        if (!operation || typeof operation.operationId !== "string" || !UUID.test(operation.operationId)) throw new Error("The recovery response could not be verified.");
        setEntries(current => current.map(item => item.id === entry.id ? { ...item, state: "accepted", operationId: operation.operationId as string, error: undefined } : item));
      } else if (value.state === "expired_not_accepted") {
        removeExpired(entry);
        setEntries(current => current.map(item => item.id === entry.id ? { ...item, state: "expired", error: undefined } : item));
      } else if (value.state === "pending" || value.state === "prepared") {
        setEntries(current => current.map(item => item.id === entry.id ? { ...item, state: "pending", error: undefined } : item));
      } else throw new Error("The recovery response could not be verified.");
    } catch (cause) {
      setEntries(current => current.map(item => item.id === entry.id ? { ...item, state: "error", error: cause instanceof Error ? cause.message : "Recovery is unavailable." } : item));
    }
  }, [removeExpired]);

  useEffect(() => {
    if (!loaded) return;
    entries.filter(entry => entry.state === "checking" && !inFlight.current.has(entry.id)).forEach(entry => {
      inFlight.current.add(entry.id);
      void check(entry).finally(() => inFlight.current.delete(entry.id));
    });
  }, [check, entries, loaded]);

  const active = useMemo(() => entries.filter(entry => entry.state !== "expired"), [entries]);
  return <main className="mx-auto max-w-3xl space-y-6 p-6" data-testid="inbox-receipt-recovery">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm text-muted-foreground">Sandra Inbox</p><h1 className="text-2xl font-semibold">Action recovery</h1><p className="text-sm text-muted-foreground">Check accepted or uncertain work from this authenticated session.</p></div><a className="rounded border px-3 py-2 text-sm" href="/messages">Back to Messages</a></div>
    {!loaded && <p role="status">Checking for recoverable actions…</p>}
    {loaded && !active.length && <section className="rounded border p-4"><p>No accepted or uncertain actions need recovery.</p><p className="mt-1 text-sm text-muted-foreground">This page never retries a send or accepts a prepared action for you.</p></section>}
    {active.length > 0 && <ul className="space-y-3">{active.map(entry => <li key={entry.id} className="rounded border p-4"><p className="font-medium">{entry.kind === "reply" ? "Reviewed reply" : "Inbox action"}</p><p className="break-all text-xs text-muted-foreground">Preparation {entry.preparationId}</p><p role={entry.error ? "alert" : "status"} className="mt-2">{entry.error ?? (entry.state === "checking" ? "Checking the server…" : entry.state === "pending" ? "Not confirmed yet; the original identifiers are retained." : entry.state === "accepted" ? "Accepted. Open the durable receipt to inspect progress." : "The earlier action expired without being accepted.")}</p>{entry.state === "accepted" && entry.operationId ? <a className="mt-3 inline-block rounded border px-3 py-2 text-sm" href={`/inbox/${entry.kind === "reply" ? "replies" : "operations"}/${encodeURIComponent(entry.operationId)}`}>Open receipt</a> : entry.state !== "expired" && <button type="button" className="mt-3 rounded border px-3 py-2 text-sm" onClick={() => void check(entry)}>Check again</button>}</li>)}</ul>}
    {entries.some(entry => entry.state === "expired") && <p role="status" className="text-sm text-muted-foreground">An expired record was removed from this authenticated session.</p>}
    {loaded && <button type="button" className="rounded border px-3 py-2 text-sm" onClick={reload}>Refresh recovery records</button>}
  </main>;
}
