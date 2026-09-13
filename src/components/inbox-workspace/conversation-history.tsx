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
  /** Clear the containing Query cache and summary collections on live revocation. */
  onAccessLost: () => void;
  fetch?: typeof fetch;
}
type ReadState = { boundary: string; status: "pending" | "complete" | "error" | "expired" | "permission_lost" };

/** Mount only inside the opened detail pane. Prefetch belongs to the Query cache,
 * not this rendered component. SQL receipts make Strict Mode/retry replay safe.
 */
export function ConversationHistory(props: ConversationHistoryProps) {
  const { orgId, conversationId, requestGeneration, snapshot, visible, onAccessLost } = props;
  const data = snapshot?.requestGeneration === requestGeneration && snapshot.data.orgId === orgId &&
    snapshot.data.conversationId === conversationId ? snapshot.data : null;
  const [readState, setReadState] = useState<ReadState | null>(null);
  const [retry, setRetry] = useState(0);
  const progress = useRef<{ boundary: string; batch: number; complete: boolean; revoked: boolean } | null>(null);
  const transport = props.fetch ?? fetch;
  useEffect(() => {
    if (!data || !visible) return;
    const controller = new AbortController();
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
              if (response.status === 401 || response.status === 403) {
                current.revoked = true;
                setReadState({ boundary, status: "permission_lost" });
                controller.abort();
                onAccessLost();
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
  }, [data, visible, requestGeneration, transport, retry, onAccessLost]);
  if (!data || !visible) return null;
  const status = readState?.boundary === data.readBoundary ? readState.status : "pending";
  if (status === "permission_lost") return null;
  return <section aria-label="Conversation history">
    <ol className="space-y-3">
      {[...data.history].reverse().map(message => <li key={message.id} className={message.direction === "outbound" ? "ml-8 rounded-lg bg-muted p-3" : "mr-8 rounded-lg border p-3"}>
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
