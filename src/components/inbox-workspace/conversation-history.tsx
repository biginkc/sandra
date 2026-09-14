"use client";

import { useEffect, useRef, useState } from "react";
import type { createInboxReadRepository } from "@/lib/inbox/read-api";

export type InboxDetailSnapshot = Awaited<ReturnType<ReturnType<typeof createInboxReadRepository>["detail"]>>;
export interface ConversationHistoryProps {
  orgId: string;
  conversationId: string;
  /** An A→B→A navigation has a new generation even though the identity matches. */
  requestGeneration: number;
  snapshot: { requestGeneration: number; data: InboxDetailSnapshot } | null;
  visible: boolean;
  onRefresh: () => void;
  /** Clear the containing Query cache and summary collections on live revocation
   * (org/membership-scoped denial: 401/403). Latches the whole workspace. */
  onAccessLost: () => void;
  /** A single item-scoped denial (404: not found / dismissed / purged cursor).
   * Only this conversation is affected — invalidate and close just this pane. */
  onUnavailable: (conversationId: string) => void;
  fetch?: typeof fetch;
}
type ReadState = { boundary: string; status: "pending" | "complete" | "error" | "expired" | "permission_lost" };

/** Mount only inside the opened detail pane. Prefetch belongs to the Query cache,
 * not this rendered component. SQL receipts make Strict Mode/retry replay safe.
 */
export function ConversationHistory(props: ConversationHistoryProps) {
  const { orgId, conversationId, requestGeneration, snapshot, visible, onAccessLost, onUnavailable } = props;
  const data = snapshot?.requestGeneration === requestGeneration && snapshot.data.orgId === orgId &&
    snapshot.data.conversationId === conversationId ? snapshot.data : null;
  const [readState, setReadState] = useState<ReadState | null>(null);
  const [retry, setRetry] = useState(0);
  const [revokedBoundary, setRevokedBoundary] = useState<string | null>(null);
  const progress = useRef<{ boundary: string; batch: number; complete: boolean; revoked: boolean } | null>(null);
  const transport = props.fetch ?? fetch;
  const pagingRequest = useRef<AbortController | null>(null);
  const readRequest = useRef<AbortController | null>(null);
  const [paging, setPaging] = useState<{ boundary: string; pages: InboxDetailSnapshot[]; shifted: boolean; busy: boolean; error?: string } | null>(null);
  const pageState = paging?.boundary === data?.readBoundary ? paging : null;
  const pages = pageState?.pages ?? (data ? [data] : []);
  const nextCursor = pages.at(-1)?.nextCursor;
  useEffect(() => () => { pagingRequest.current?.abort(); }, [data?.readBoundary, requestGeneration]);
  async function older() {
    if (!data || !nextCursor || pageState?.busy || progress.current?.revoked) return;
    pagingRequest.current?.abort();
    const controller = new AbortController(); pagingRequest.current = controller;
    const boundary = data.readBoundary;
    setPaging({ boundary, pages, shifted: pageState?.shifted ?? false, busy: true });
    try {
      const response = await transport(`/api/inbox/conversations/${conversationId}/detail?orgId=${orgId}&before=${nextCursor}`, {
        credentials: "same-origin", redirect: "error", cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (controller.signal.aborted) return;
      // 401/403 is org/membership-scoped denial (read-api.ts): the whole workspace
      // has lost access, so latch permission_lost and let the owner clear everything.
      if (response.status === 401 || response.status === 403) {
        if (progress.current?.boundary === boundary) progress.current.revoked = true;
        setRevokedBoundary(boundary); setReadState({ boundary, status: "permission_lost" }); controller.abort(); readRequest.current?.abort(); onAccessLost(); return;
      }
      // 404 here is item-scoped (INBOX_READ_NOT_FOUND / INBOX_ACCESS_DENIED, or the
      // server flag being off) — only this conversation is unavailable, not the whole
      // workspace. Stop this boundary's acknowledgments and let the owner close/invalidate
      // just this pane instead of latching the entire workspace as access-denied.
      if (response.status === 404) {
        if (progress.current?.boundary === boundary) progress.current.revoked = true;
        setReadState({ boundary, status: "error" }); controller.abort(); readRequest.current?.abort(); onUnavailable(conversationId); return;
      }
      if (response.status === 410) throw Error("Refresh messages to continue through older history.");
      if (!response.ok) throw Error("Older messages could not load. Try again.");
      const page: InboxDetailSnapshot = await response.json();
      if (controller.signal.aborted) return;
      if (page.orgId !== orgId || page.conversationId !== conversationId || page.requesterId !== data.requesterId || page.readBoundary !== boundary ||
        !Array.isArray(page.history) || page.history.length > 50 || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw Error("Older history did not match this conversation.");
      // Keep the cached newest page plus one older page: at most 100 messages
      // for this conversation, including the parent Query cache.
      setPaging({ boundary, pages: [page], shifted: true, busy: false });
    } catch (failure) {
      if (!controller.signal.aborted) setPaging({ boundary, pages, shifted: pageState?.shifted ?? false, busy: false, error: failure instanceof Error ? failure.message : "Older messages unavailable." });
    }
  }
  useEffect(() => {
    if (!data || !visible) return;
    const controller = new AbortController(); readRequest.current = controller;
    let frame: number | undefined;
    let started = false;
    const boundary = data.readBoundary;
    if (progress.current?.boundary !== boundary) progress.current = { boundary, batch: 0, complete: false, revoked: false };
    const current = progress.current;
    if (current.revoked) return;
    const start = () => {
      if (started || controller.signal.aborted || document.visibilityState !== "visible") return;
      started = true;
      // The effect runs after React commits the matching history. Deferring one
      // frame also lets a superseding navigation cancel before dispatch begins.
      frame = requestAnimationFrame(() => {
        if (controller.signal.aborted) return;
        if (document.visibilityState !== "visible") { started = false; return; }
        if (current.complete) { setReadState({ boundary, status: "complete" }); return; }
        if (current.batch === 0 && Date.parse(data.boundaryExpiresAt) <= Date.now()) {
          setReadState({ boundary, status: "expired" }); return;
        }
        setReadState({ boundary, status: "pending" });
        void (async () => {
          try {
            while (!controller.signal.aborted && !current.complete) {
              const batch = current.batch;
              const response = await transport("/api/inbox/read-acknowledgments", {
                method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
                headers: { "content-type": "application/json" }, body: JSON.stringify({ boundaryId: boundary, batch }),
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
              });
              if (controller.signal.aborted) return;
              // Org/membership-scoped denial: the whole workspace has lost access.
              if (response.status === 401 || response.status === 403) {
                current.revoked = true;
                pagingRequest.current?.abort();
                setRevokedBoundary(boundary); setReadState({ boundary, status: "permission_lost" });
                controller.abort();
                onAccessLost();
                return;
              }
              // Item-scoped denial (this conversation only, or the server flag off).
              // Stop this boundary's remaining acknowledgments and let the owner
              // close/invalidate just this pane rather than latch the workspace.
              if (response.status === 404) {
                current.revoked = true;
                pagingRequest.current?.abort();
                setReadState({ boundary, status: "error" });
                controller.abort();
                onUnavailable(conversationId);
                return;
              }
              if (response.status === 410) { setReadState({ boundary, status: "expired" }); return; }
              if (!response.ok) throw Error("Read acknowledgment failed");
              const receipt: unknown = await response.json();
              if (controller.signal.aborted) return;
              if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw Error("Invalid receipt");
              const row = receipt as Record<string, unknown>;
              if (row.boundaryId !== boundary || row.batch !== batch || typeof row.completed !== "boolean" ||
                !Number.isInteger(row.changed) || (row.changed as number) < 0 || (row.changed as number) > 200) throw Error("Invalid receipt");
              current.batch = batch + 1;
              current.complete = row.completed;
            }
            if (!controller.signal.aborted) setReadState({ boundary, status: "complete" });
          } catch {
            if (!controller.signal.aborted) setReadState({ boundary, status: "error" });
          }
        })();
      });
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => { controller.abort(); if (frame !== undefined) cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", start); };
  }, [data, visible, requestGeneration, transport, retry, onAccessLost, onUnavailable]);
  if (!data || !visible) return null;
  const status = readState?.boundary === data.readBoundary ? readState.status : "pending";
  if (status === "permission_lost" || revokedBoundary === data.readBoundary) return null;
  return <section aria-label="Conversation history">
    <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
      {nextCursor && <button type="button" className="underline" disabled={pageState?.busy} onClick={() => void older()}>{pageState?.busy ? "Loading older messages…" : "Load older messages"}</button>}
      {pageState?.shifted && <><span>Showing older messages.</span><button type="button" className="underline" onClick={() => { pagingRequest.current?.abort(); setPaging(null); }}>Back to latest messages</button></>}
      {pageState?.error && <span role="alert">{pageState.error}</span>}
    </div>
    <ol className="space-y-3">
      {[...new Map(pages.flatMap(page => page.history).map(message => [message.id, message])).values()].reverse().map(message => <li key={message.id} className={message.direction === "outbound" ? "ml-8 rounded-lg bg-muted p-3" : "mr-8 rounded-lg border p-3"}>
        <p className="whitespace-pre-wrap break-words">{message.body ?? ""}</p>
        <p className="mt-1 text-xs text-muted-foreground">{message.direction === "outbound" ? "Sent" : "Received"} · <time dateTime={message.createdAtRaw}>{new Date(message.createdAtRaw).toLocaleString()}</time></p>
      </li>)}
    </ol>
    <div aria-live="polite" className="mt-3 text-sm text-muted-foreground">
      {status === "pending" && "Updating read status…"}
      {status === "error" && <><span>Read status could not finish updating. </span><button type="button" className="underline" onClick={() => setRetry(value => value + 1)}>Retry</button></>}
      {status === "expired" && <><span>Refresh this conversation to update its read status. </span><button type="button" className="underline" onClick={props.onRefresh}>Refresh messages</button></>}
    </div>
  </section>;
}
