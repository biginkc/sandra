"use client";
import { useEffect, useRef, useState } from "react";
import type { createInboxReadRepository } from "@/lib/inbox/read-api";
export type UnknownSenderHistorySnapshot = Awaited<ReturnType<ReturnType<typeof createInboxReadRepository>["unknownHistory"]>>;
export interface UnknownSenderHistoryProps {
  orgId: string; senderGroupId: string; requestGeneration: number; visible: boolean;
  snapshot: { requestGeneration: number; data: UnknownSenderHistorySnapshot } | null;
  onAccessLost: () => void; onRefresh: () => void; fetch?: typeof fetch;
}
/** Read-only raw sender history. Opening it never acknowledges a conversation. */
export function UnknownSenderHistory(props: UnknownSenderHistoryProps) {
  const { orgId, senderGroupId, requestGeneration, snapshot, visible, onAccessLost, onRefresh } = props;
  const initial = snapshot?.requestGeneration === requestGeneration && snapshot.data.orgId === orgId && snapshot.data.senderGroupId === senderGroupId ? snapshot.data : null;
  const key = `${orgId}:${senderGroupId}:${requestGeneration}`;
  const [state, setState] = useState<{ key: string; page: UnknownSenderHistorySnapshot; busy: boolean; error?: string } | null>(null);
  const [revoked, setRevoked] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, [key, initial, visible]);
  const current = state?.key === key ? state : null;
  const page = current?.page ?? initial;
  async function older() {
    if (!page?.nextCursor || !initial || current?.busy || revoked === key || !visible) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setState({ key, page, busy: true });
    try {
      const response = await (props.fetch ?? fetch)(`/api/inbox/unknown-senders/${senderGroupId}/history?orgId=${orgId}&before=${page.nextCursor}`, {
        credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403) { setRevoked(key); onAccessLost(); return; }
      if (response.status === 410) throw Error("Refresh messages to continue through older history.");
      if (!response.ok) throw Error("Older messages could not load. Try again.");
      const next: UnknownSenderHistorySnapshot = await response.json();
      if (controller.signal.aborted) return;
      if (next.orgId !== orgId || next.senderGroupId !== senderGroupId || next.requesterId !== initial.requesterId || next.rawSender !== initial.rawSender ||
        !Array.isArray(next.history) || next.history.length > 50 || !(next.nextCursor === null || /^[a-f0-9-]{36}$/.test(next.nextCursor))) throw Error("History did not match this sender.");
      setState({ key, page: next, busy: false });
    } catch (error) {
      if (!controller.signal.aborted) setState({ key, page, busy: false, error: error instanceof Error ? error.message : "History unavailable." });
    }
  }
  if (!visible || !initial || !page || revoked === key) return null;
  return <section aria-label="Unknown sender history">
    <h2>{initial.rawSender}</h2>
    <p>Message history</p>
    {current && <button type="button" disabled={current.busy} onClick={() => setState(null)}>Back to latest messages</button>}
    {page.nextCursor && <button type="button" disabled={current?.busy} onClick={() => void older()}>{current?.busy ? "Loading older messages…" : "Load older messages"}</button>}
    {current?.error && <div role="alert">{current.error} <button type="button" onClick={onRefresh}>Refresh messages</button></div>}
    <ol>{[...page.history].reverse().map(message => <li key={message.id}>
      <span>{message.direction === "inbound" ? "Received" : "Sent"}</span>{" "}
      <time dateTime={message.createdAtRaw}>{message.createdAtRaw}</time>
      <p>{message.body ?? ""}</p>{message.dismissedAtRaw && <span>Dismissed</span>}
    </li>)}</ol>
  </section>;
}
