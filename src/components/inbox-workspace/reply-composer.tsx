"use client";

import { useEffect, useRef, useState } from "react";
import { TemplatePicker } from "@/app/(dashboard)/templates/template-picker";

type ReplyItem = { id: string; target: { kind: "conversation" | "unknown_sender_group"; id: string }; exclusion: string | null; recipient: null | { contactName: string; propertyAddress: string; renderedBody: string; to: string } };
type PreparedReply = { preparationId: string; idempotencyKey: string; expiresAt: string; items: readonly ReplyItem[]; recipientCount: number; blockers: readonly string[] };
type State = { body: string; stage: "idle" | "preparing" | "prepared" | "accepting" | "accepted"; prepared?: PreparedReply; operationId?: string; result?: string; error?: string };

function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function decode(value: unknown, key: string, conversationId: string): PreparedReply {
  const row = object(value);
  const prepared = row && object(row.prepared) ? row.prepared : row;
  const candidate = prepared as Record<string, unknown> | null;
  if (!candidate || typeof candidate.preparationId !== "string" || candidate.idempotencyKey !== key || !Number.isFinite(Date.parse(String(candidate.expiresAt))) || !Array.isArray(candidate.items) || candidate.items.length !== 1 || !Number.isSafeInteger(candidate.recipientCount) || !Array.isArray(candidate.blockers)) throw new Error("Reply review could not be verified.");
  const item = object(candidate.items[0]);
  const target = item && object(item.target);
  if (!item || !target || target.kind !== "conversation" || target.id !== conversationId || typeof item.id !== "string" || (item.exclusion !== null && typeof item.exclusion !== "string")) throw new Error("Reply review did not match this conversation.");
  return prepared as unknown as PreparedReply;
}

/** Single-conversation composer using the reviewed bulk-reply route. It never
 * calls a provider or accepts from browser text until the server freezes the
 * recipient route and rendered body. */
export function InboxReplyComposer({ conversationId, enabled = false }: { conversationId: string; enabled?: boolean }) {
  const [state, setState] = useState<State>({ body: "", stage: "idle" });
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort();
    setState({ body: "", stage: "idle" });
    setRetry(0);
  }, [conversationId]);
  const send = async () => {
    const body = state.body.trim();
    if (!body || state.stage === "preparing" || state.stage === "accepting" || state.stage === "accepted") return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const idempotencyKey = crypto.randomUUID();
    setState({ body: state.body, stage: "preparing" });
    try {
      const response = await fetch("/api/inbox/replies/prepare", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", redirect: "error", body: JSON.stringify({ idempotencyKey, targets: [{ kind: "conversation", id: conversationId }], template: body }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) throw new Error(response.status === 404 ? "Reviewed replies are not enabled for this workspace yet." : "Reply review could not be prepared. Try again.");
      const prepared = decode(await response.json(), idempotencyKey, conversationId);
      if (controller.signal.aborted) return;
      setState({ body: state.body, stage: "prepared", prepared });
    } catch (error) { if (!controller.signal.aborted) setState({ body: state.body, stage: "idle", error: error instanceof Error ? error.message : "Reply review could not be prepared." }); }
  };
  const accept = async () => {
    if (!state.prepared || state.stage !== "prepared" || state.prepared.recipientCount !== 1 || state.prepared.blockers.length || Date.parse(state.prepared.expiresAt) <= Date.now()) return;
    const prepared = state.prepared;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setState(current => ({ ...current, stage: "accepting", error: undefined }));
    try {
      const recovery = await fetch(`/api/inbox/replies/recover?preparationId=${encodeURIComponent(prepared.preparationId)}&idempotencyKey=${encodeURIComponent(prepared.idempotencyKey)}`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (recovery.ok) {
        const recovered = object(await recovery.json());
        const operation = recovered && object(recovered.operation);
        if (recovered?.state === "accepted" && operation && typeof operation.operationId === "string") {
          const operationId = operation.operationId;
          setState(current => ({ ...current, stage: "accepted", operationId, error: undefined }));
          return;
        }
        if (recovered?.state === "expired_not_accepted") throw new Error("This review expired. Prepare the reply again.");
      }
      const response = await fetch("/api/inbox/replies/accept", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", redirect: "error", body: JSON.stringify({ preparationId: prepared.preparationId, idempotencyKey: prepared.idempotencyKey }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) throw new Error("We could not confirm whether this reply started. Retry safely with this same review.");
      const value = object(await response.json());
      if (!value || typeof value.operationId !== "string") throw new Error("The reply response could not be verified. Retry with this same review.");
      const operationId = value.operationId;
      setState(current => ({ ...current, stage: "accepted", operationId }));
    } catch (error) { if (!controller.signal.aborted) setState(current => ({ ...current, stage: "prepared", error: error instanceof Error ? error.message : "We could not confirm whether this reply started. Retry safely with this same review." })); }
  };
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!state.operationId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch(`/api/inbox/replies/${encodeURIComponent(state.operationId!)}`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new Error("Reply progress is unavailable. The reply may still be running.");
        const value = object(await response.json());
        if (!value || value.operationId !== state.operationId || !Array.isArray(value.receipts)) throw new Error("Reply progress could not be verified.");
        if (value.dispatchComplete === true) {
          setState(current => ({ ...current, stage: "accepted", result: typeof value.result === "string" ? value.result : "completed", error: undefined }));
          return;
        }
        timer = setTimeout(() => void poll(), 1000);
      } catch (error) { if (!controller.signal.aborted) { setState(current => ({ ...current, error: error instanceof Error ? error.message : "Reply progress is unavailable." })); timer = setTimeout(() => void poll(), 2000); } }
    }
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [state.operationId, retry]);
  if (!enabled) return null;
  const pending = state.stage === "preparing" || state.stage === "accepting";
  const editBody = (body: string) => setState(current => ({ body, stage: "idle", error: undefined }));
  return <section aria-label="Reply to conversation" className="mt-5 border-t pt-4"><h3>Reply</h3><textarea aria-label="Reply message" rows={3} maxLength={1600} value={state.body} disabled={pending || state.stage === "accepted"} onChange={event => editBody(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void send(); } }} placeholder="Write a reply… (⌘/Ctrl + Enter to review)" /><div className="mt-2 flex flex-wrap items-center gap-2">{!pending && state.stage !== "accepted" && <TemplatePicker onSelect={template => editBody(template.content)} />}<button type="button" onClick={() => void send()} disabled={pending || !state.body.trim() || state.stage === "accepted"}>{state.stage === "preparing" ? "Preparing…" : "Review reply"}</button><span>{state.body.length} / 1600</span></div>{state.error && <p role="alert">{state.error}{state.operationId && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry progress</button>}</p>}{state.prepared && <div role="dialog" aria-label="Review reply" className="mt-3 rounded border p-3"><h4>Review reply</h4>{state.prepared.items.map(item => <p key={item.id}>{item.exclusion ? `Blocked: ${item.exclusion}` : item.recipient ? <>To {item.recipient.contactName} ({item.recipient.to})<br /><span className="whitespace-pre-wrap">{item.recipient.renderedBody}</span></> : "Needs attention"}</p>)}{state.prepared.blockers.length > 0 && <p>Blocked: {state.prepared.blockers.join(", ")}</p>}<button type="button" onClick={() => void accept()} disabled={pending || state.prepared.recipientCount !== 1 || state.prepared.blockers.length > 0}>{state.stage === "accepting" ? "Accepting…" : state.stage === "accepted" ? state.result ? `Reply ${state.result}` : "Accepted · checking progress…" : "Accept reviewed reply"}</button>{state.operationId && <a href={`/api/inbox/replies/${encodeURIComponent(state.operationId)}`}>Open reply receipt</a>}</div>}</section>;
}
