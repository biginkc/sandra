"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";
import {
  type InboxReplyExclusion,
  INBOX_REPLY_RECIPIENT_LIMIT,
  INBOX_REPLY_TERMINAL_RECEIPT_STATES,
  type InboxReplyStatus,
  type InboxReplyTarget,
  type PreparedInboxReply,
  type PreparedInboxReplyItem,
} from "@/lib/inbox/reply-api-contract";
import { initialReplyState, replyStateReducer, type ReplyReview, type ReplyState } from "./reply-state-machine";
import styles from "./reply-composer.module.css";

type ReplyComposerProps = {
  targets: readonly InboxReplyTarget[];
  names?: ReadonlyMap<string, string>;
  enabled?: boolean;
  routeKey?: string;
  onClose?: () => void;
  fetcher?: typeof fetch;
  initialDraft?: string;
  /** Preview-only hydration hook; production callers continue from ready. */
  initialState?: ReplyState;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 1600;

// The server checks these codes in the authoritative recipient predicate and
// returns them from reply-api.ts:136-150. The policy itself is in
// experiments/inbox-reply-preparation/recipient.sql:88-195; these strings only
// restate each check because the existing boundary has no operator-facing copy.
export const exclusionCopy: Record<InboxReplyExclusion, string> = {
  unsupported_target: "This target is not a supported conversation.",
  conversation_unavailable: "This conversation is unavailable.",
  property_unavailable: "The property is unavailable.",
  property_suppressed: "The property is suppressed from replies.",
  contact_mapping_unavailable: "The contact no longer matches this property.",
  contact_suppressed: "This contact is suppressed from replies.",
  inbound_unavailable: "No eligible inbound message was found.",
  conversation_changed: "The conversation changed since it was captured.",
  inbound_mapping_changed: "The inbound message no longer matches this conversation.",
  reply_route_unavailable: "The conversation's reply route is unavailable.",
  phone_not_saved: "The reply number is not saved on the contact.",
  landline: "The reply number is a landline.",
  unclassified_phone: "The saved phone type is not confirmed mobile.",
  sms_suppressed: "SMS is suppressed for this number.",
  no_consent: "No affirmative SMS consent is on file.",
  sender_unavailable: "The sending number is unavailable.",
  context_unavailable: "Required reply context is unavailable.",
  conversation_window_expired: "The conversation's reply window expired.",
  unknown_state: "The property's state is unknown for reply timing.",
  outside_window: "The reply is outside the allowed sending window.",
  missing_variable: "The message is missing a required value.",
  invalid_template: "The message template is invalid.",
  invalid_body: "The message body is invalid.",
  contact_unavailable: "The contact is unavailable.",
};

const blockerCopy: Record<"empty" | "recipient_limit" | "duplicate_destination", string> = {
  empty: "No eligible recipients remain in this review.",
  recipient_limit: `The server found more than ${INBOX_REPLY_RECIPIENT_LIMIT} distinct eligible reply destinations after exclusions and duplicate destinations were removed. Narrow the selection and review again.`,
  duplicate_destination: "Two selected conversations share the same destination.",
};

const UNCONFIRMED_RECEIPT_STATES = ["pending", "dispatch_started", "uncertain"] as const;
const POLL_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 16000, 30000] as const;
// reply-api.ts:375-388 exposes no operation timeout. Two minutes without a
// receipt-state change is an operational default, not a server completion claim.
export const MAX_POLL_DURATION_MS = 120_000;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function target(value: unknown): InboxReplyTarget | null {
  const row = object(value);
  if (!row || !["conversation", "unknown_sender_group"].includes(String(row.kind)) || typeof row.id !== "string" || !UUID.test(row.id)) return null;
  return { kind: row.kind as InboxReplyTarget["kind"], id: row.id };
}

function parseItem(value: unknown): PreparedInboxReplyItem {
  const row = object(value);
  const itemTarget = row && target(row.target);
  if (!row || !itemTarget || typeof row.id !== "string" || typeof row.duplicateDestination !== "boolean") throw Error("The reply review could not be verified.");
  const exclusion = row.exclusion === null ? null : typeof row.exclusion === "string" && Object.hasOwn(exclusionCopy, row.exclusion) ? row.exclusion as InboxReplyExclusion : undefined;
  if (exclusion === undefined) throw Error("The reply review could not be verified.");
  if (exclusion !== null) {
    if (row.recipient !== null) throw Error("The reply review could not be verified.");
    return { id: row.id, target: itemTarget, exclusion, recipient: null, duplicateDestination: row.duplicateDestination };
  }
  const recipient = object(row.recipient);
  if (!recipient || typeof recipient.contactName !== "string" || typeof recipient.propertyAddress !== "string" || typeof recipient.propertyId !== "string" || typeof recipient.contactId !== "string" || typeof recipient.from !== "string" || typeof recipient.to !== "string" || typeof recipient.renderedBody !== "string") throw Error("The reply review could not be verified.");
  return {
    id: row.id,
    target: itemTarget,
    exclusion: null,
    duplicateDestination: row.duplicateDestination,
    recipient: {
      contactName: recipient.contactName,
      propertyAddress: recipient.propertyAddress,
      propertyId: recipient.propertyId,
      contactId: recipient.contactId,
      from: recipient.from,
      to: recipient.to,
      renderedBody: recipient.renderedBody,
    },
  };
}

export function parsePreparedReply(value: unknown, idempotencyKey: string): PreparedInboxReply {
  const row = object(value);
  const prepared = object(row && object(row.prepared) ? row.prepared : row);
  if (!prepared || typeof prepared.preparationId !== "string" || !UUID.test(prepared.preparationId) || prepared.idempotencyKey !== idempotencyKey || typeof prepared.expiresAt !== "string" || !Number.isFinite(Date.parse(prepared.expiresAt)) || !Array.isArray(prepared.items) || prepared.items.length > 500 || typeof prepared.recipientCount !== "number" || !Number.isSafeInteger(prepared.recipientCount) || prepared.recipientCount < 0 || !Array.isArray(prepared.blockers)) throw Error("The reply review could not be verified.");
  const blockers = prepared.blockers.filter((value): value is keyof typeof blockerCopy => Object.hasOwn(blockerCopy, value));
  if (blockers.length !== prepared.blockers.length || new Set(blockers).size !== blockers.length) throw Error("The reply review could not be verified.");
  const items = prepared.items.map(parseItem);
  if (items.length !== 0 && prepared.recipientCount > items.filter(item => item.exclusion === null && item.recipient !== null).length) throw Error("The reply review could not be verified.");
  return {
    preparationId: prepared.preparationId,
    idempotencyKey: prepared.idempotencyKey,
    inputHash: typeof prepared.inputHash === "string" ? prepared.inputHash : "",
    expiresAt: prepared.expiresAt,
    items,
    recipientCount: prepared.recipientCount,
    blockers,
  };
}

function errorCode(value: unknown): string | null {
  const row = object(value);
  return row && typeof row.error === "string" ? row.error : null;
}

function targetKey(targetValue: InboxReplyTarget): string {
  return `${targetValue.kind}:${targetValue.id}`;
}

function receiptLabel(status: InboxReplyStatus): string {
  if (status.receipts.some(receipt => receipt.state === "delivered")) return "Delivered";
  if (status.receipts.some(receipt => receipt.state === "provider_accepted")) return "Accepted by provider";
  if (status.receipts.some(receipt => receipt.state === "delivery_failed")) return "Delivery failed";
  if (status.receipts.some(receipt => receipt.state === "confirmed_not_submitted" || receipt.state === "rejected_unsent")) return "Not submitted";
  return "Checking receipt";
}

function statusMessage(status: InboxReplyStatus): string {
  if (status.receipts.some(receipt => receipt.state === "uncertain")) return "The provider result is not yet confirmed. Do not resend this reply.";
  if (status.receipts.some(receipt => UNCONFIRMED_RECEIPT_STATES.includes(receipt.state as typeof UNCONFIRMED_RECEIPT_STATES[number]))) return "The durable receipt is still being checked.";
  const failure = status.receipts.find(receipt => receipt.reason)?.reason;
  return failure ?? (receiptLabel(status) === "Accepted by provider" ? "The provider accepted the reply; delivery can update separately." : "The server recorded the reply result.");
}

function isTerminalReceiptState(state: InboxReplyStatus["receipts"][number]["state"]): boolean {
  return INBOX_REPLY_TERMINAL_RECEIPT_STATES.includes(state as typeof INBOX_REPLY_TERMINAL_RECEIPT_STATES[number]);
}

function statusFingerprint(status: InboxReplyStatus): string {
  return JSON.stringify({
    dispatchComplete: status.dispatchComplete,
    receipts: [...status.receipts]
      .map(receipt => ({ itemId: receipt.itemId, version: receipt.version, state: receipt.state, reason: receipt.reason }))
      .sort((left, right) => left.itemId.localeCompare(right.itemId)),
  });
}

function terminalStatus(status: InboxReplyStatus): boolean {
  return status.receipts.length > 0 && status.receipts.every(receipt => isTerminalReceiptState(receipt.state));
}

function receiptProgress(status: InboxReplyStatus): { completed: number; total: number } {
  return {
    completed: status.receipts.filter(receipt => isTerminalReceiptState(receipt.state)).length,
    total: status.receipts.length,
  };
}

function PreparedReview({ prepared, names, onEdit, onSend, sending, bulk }: { prepared: PreparedInboxReply; names?: ReadonlyMap<string, string>; onEdit: () => void; onSend: () => void; sending: boolean; bulk: boolean }) {
  const eligible = prepared.items.filter(item => item.exclusion === null && item.recipient !== null);
  return <section className={styles.review} aria-label="Review reply">
    <div className={styles.reviewHeader}><div><h4>Review before sending</h4><p>{eligible.length} recipient{eligible.length === 1 ? "" : "s"} included · {prepared.items.length - eligible.length} excluded</p></div><span className={styles.eyebrow}>SERVER CHECKED</span></div>
    {prepared.blockers.length > 0 && <div className={styles.error} role="alert"><strong>Reply blocked</strong>{prepared.blockers.map(blocker => <p key={blocker}>{blockerCopy[blocker]}</p>)}</div>}
    <ul className={styles.reviewList}>{prepared.items.map(item => {
      const recipient = item.recipient;
      const label = recipient?.contactName ?? names?.get(targetKey(item.target)) ?? "Selected conversation";
      return <li key={item.id} className={`${styles.recipient} ${item.exclusion ? styles.recipientBlocked : ""}`}>
        <div className={styles.recipientHead}><div><div className={styles.recipientName}>{label}</div><div className={styles.recipientAddress}>{recipient?.propertyAddress ?? "Not eligible for this reply"}</div></div><span className={styles.eyebrow}>{recipient ? "INCLUDED" : "EXCLUDED"}</span></div>
        {item.exclusion && <p className={styles.blockedCopy}>{exclusionCopy[item.exclusion]}</p>}
        {recipient && <><div className={styles.routeGrid}><div><span>From</span><strong>{recipient.from}</strong></div><div><span>To</span><strong>{recipient.to}</strong></div></div><p className={styles.bodyPreview}>{recipient.renderedBody}</p></>}
      </li>;
    })}</ul>
    <div className={styles.actions}><button className={styles.secondary} type="button" onClick={onEdit} disabled={sending}>Edit</button>{eligible.length > 0 && prepared.blockers.length === 0 && <button className={styles.primary} type="button" onClick={onSend} disabled={sending}>{sending ? "Sending…" : bulk ? `Send to ${prepared.recipientCount} recipients` : "Send reply"}</button>}</div>
  </section>;
}

function ReceiptSummary({ status, operationId, bulk, sending = false, uncertainResult = false, message }: { status?: InboxReplyStatus; operationId?: string; bulk: boolean; sending?: boolean; uncertainResult?: boolean; message?: string }) {
  if (!status && !operationId) return null;
  const uncertain = uncertainResult || !!status?.receipts.some(receipt => receipt.state === "uncertain");
  const progress = status ? receiptProgress(status) : null;
  const stillSending = sending && !!status && !uncertain && !terminalStatus(status);
  return <section className={`${styles.receipt} ${uncertain ? styles.uncertain : ""}`} role={uncertain ? "alert" : "status"}>
    <strong>{uncertain ? "Send result not confirmed" : stillSending ? "Still sending…" : status ? receiptLabel(status) : "Checking receipt"}</strong>
    <p>{uncertain && message ? message : stillSending && progress ? `${progress.completed} of ${progress.total} recipients have a terminal receipt. We’ll keep checking the server; do not resend this reply.` : status ? statusMessage(status) : uncertain ? "The send result was not confirmed. Do not resend this reply." : "The durable receipt is still being checked."}{uncertain ? " Check the receipt or conversation manually; this screen will not resend it." : ""}</p>
    {status && <ul className={styles.receiptList}>{status.items.map(item => {
      const receipt = status.receipts.find(value => value.itemId === item.id);
      const name = item.recipient?.contactName ?? "Excluded recipient";
      return <li className={styles.receiptRow} key={item.id}><span>{name}</span><strong>{receipt?.state ?? (item.exclusion ? "excluded" : "pending")}</strong></li>;
    })}</ul>}
    {operationId && <a href={`/inbox/replies/${encodeURIComponent(operationId)}`} className={styles.secondary}>{bulk ? "Open bulk receipt" : "Open reply receipt"}</a>}
  </section>;
}

export function InboxReplyComposer({ targets, names, enabled = false, routeKey = "route-unknown", onClose, fetcher, initialDraft = "", initialState }: ReplyComposerProps) {
  const [state, dispatch] = useReducer(replyStateReducer, { draft: initialDraft, state: initialState }, value => value.state ?? initialReplyState(value.draft));
  const sendInFlight = useRef(false);
  const request = useRef<AbortController | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bulk = targets.length > 1;
  const targetKeyValue = useMemo(() => targets.map(targetKey).sort().join("|"), [targets]);
  const requestFetch = fetcher ?? fetch;

  useEffect(() => {
    dispatch(initialState ? { type: "initialize", state: initialState } : { type: "reset", draft: initialDraft });
    request.current?.abort();
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    sendInFlight.current = false;
  }, [initialDraft, initialState, targetKeyValue]);

  useEffect(() => {
    if (state.phase === "reviewing" && state.review && state.review.routeKey !== routeKey) dispatch({ type: "route_changed", message: "The sending route changed. Review the current route before sending." });
  }, [routeKey, state.phase, state.review]);

  useEffect(() => () => {
    request.current?.abort();
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  async function reviewReply() {
    const draft = state.draft.trim();
    if (!draft || state.phase === "reviewing" || state.phase === "sending") return;
    dispatch({ type: "review_requested", draft: state.draft });
    const idempotencyKey = crypto.randomUUID();
    const controller = new AbortController();
    request.current?.abort(); request.current = controller;
    try {
      const response = await requestFetch("/api/inbox/replies/prepare", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", redirect: "error", body: JSON.stringify({ idempotencyKey, targets, template: draft }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error(response.status === 404 ? "Reviewed replies are not enabled for this workspace yet." : "The reply review could not be prepared."), { code: errorCode(body), status: response.status });
      const prepared = parsePreparedReply(body, idempotencyKey);
      if (controller.signal.aborted) return;
      const review: ReplyReview = { prepared, routeKey };
      if (prepared.blockers.length > 0 || prepared.recipientCount === 0) dispatch({ type: "review_blocked", review, message: prepared.blockers.map(blocker => blockerCopy[blocker]).join(" ") || "No eligible recipients remain in this review." });
      else dispatch({ type: "review_ready", review });
    } catch (error) {
      if (!controller.signal.aborted) dispatch({ type: "network_error", message: error instanceof Error ? error.message : "The reply review could not be prepared. Reconnect and try again." });
    }
  }

  function schedulePoll(operationId: string, attempt: number, unchangedSince: number, lastStatus?: InboxReplyStatus, lastFingerprint?: string) {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    const delay = POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)];
    const remaining = Math.max(0, MAX_POLL_DURATION_MS - (Date.now() - unchangedSince));
    if (remaining === 0) {
      dispatch({ type: "uncertain", status: lastStatus, message: "The receipt could not be confirmed within the polling window. Check the receipt before taking any further action." });
      return;
    }
    pollTimer.current = setTimeout(() => {
      pollTimer.current = null;
      if (Date.now() - unchangedSince >= MAX_POLL_DURATION_MS) {
        dispatch({ type: "uncertain", status: lastStatus, message: "The receipt could not be confirmed within the polling window. Check the receipt before taking any further action." });
        return;
      }
      void poll(operationId, attempt + 1, unchangedSince, lastStatus, lastFingerprint);
    }, Math.min(delay, remaining));
  }

  async function poll(operationId: string, attempt = 0, unchangedSince = Date.now(), lastStatus?: InboxReplyStatus, lastFingerprint?: string) {
    const controller = new AbortController(); request.current = controller;
    try {
      const response = await requestFetch(`/api/inbox/replies/${encodeURIComponent(operationId)}`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw Error("The reply receipt is not available yet.");
      const status = await response.json() as InboxReplyStatus;
      if (controller.signal.aborted || status.operationId !== operationId || !Array.isArray(status.receipts)) throw Error("The reply receipt could not be verified.");
      const fingerprint = statusFingerprint(status);
      const nextUnchangedSince = lastFingerprint === undefined || fingerprint !== lastFingerprint ? Date.now() : unchangedSince;
      if (status.receipts.some(receipt => receipt.state === "uncertain") || terminalStatus(status)) dispatch({ type: "receipt", status });
      else if (Date.now() - nextUnchangedSince >= MAX_POLL_DURATION_MS) dispatch({ type: "uncertain", status, message: "The receipt did not change within the polling window. Check the receipt before taking any further action." });
      else {
        dispatch({ type: "receipt_update", status });
        schedulePoll(operationId, attempt, nextUnchangedSince, status, fingerprint);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (Date.now() - unchangedSince < MAX_POLL_DURATION_MS) schedulePoll(operationId, attempt, unchangedSince, lastStatus, lastFingerprint);
        else dispatch({ type: "uncertain", status: lastStatus, message: error instanceof Error ? error.message : "The reply result could not be checked." });
      }
    }
  }

  async function sendReply() {
    const review = state.review;
    if (!review || state.phase !== "reviewing" || review.prepared.blockers.length > 0 || review.prepared.recipientCount === 0 || sendInFlight.current) return;
    sendInFlight.current = true; dispatch({ type: "send_requested" });
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    try {
      const response = await requestFetch("/api/inbox/replies/accept", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", redirect: "error", body: JSON.stringify({ preparationId: review.prepared.preparationId, idempotencyKey: review.prepared.idempotencyKey }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const code = errorCode(body);
        if (response.status === 409 && ["preparation_changed", "preparation_expired", "preparation_key_mismatch"].includes(code ?? "")) {
          dispatch({ type: "route_changed", message: code === "preparation_expired" ? "This review expired. Review the current route and message again." : "The sending route or conversation changed. Review again before sending." });
        } else {
          dispatch({ type: "uncertain", message: "The send result was not confirmed. Check the receipt before taking any further action." });
        }
        return;
      }
      const operationId = object(body)?.operationId;
      if (typeof operationId !== "string" || !UUID.test(operationId)) throw Error("The send result could not be verified.");
      dispatch({ type: "send_started", operationId });
      await poll(operationId);
    } catch (error) {
      if (!controller.signal.aborted) dispatch({ type: "uncertain", message: error instanceof Error ? error.message : "The send result was not confirmed. Check the receipt before taking any further action." });
    } finally {
      sendInFlight.current = false;
    }
  }

  if (!enabled) return null;
  const review = state.review?.prepared;
  const reviewBusy = state.phase === "reviewing" && !review;
  const sent = state.phase === "sent" || state.phase === "uncertain";
  return <section className={styles.composer} aria-label={bulk ? "Reply to selected conversations" : "Reply to conversation"}>
    <div className={styles.heading}><div><span className={styles.eyebrow}>{bulk ? "BULK REPLY" : "SINGLE REPLY"}</span><h3>{bulk ? `Reply to ${targets.length} selected conversations` : `Reply to ${names?.get(targetKey(targets[0])) ?? "this conversation"}`}</h3></div><span className={`${styles.state} ${["blocked", "route_changed", "network_error", "uncertain"].includes(state.phase) ? styles.warning : state.phase === "sent" ? styles.success : ""}`}>{state.phase === "route_changed" ? "Review discarded" : state.phase.replaceAll("_", " ")}</span></div>
    {state.phase === "route_changed" && <div className={styles.notice} role="alert"><strong>Review discarded</strong><p>{state.message}</p><p>Nothing was sent. Review the current route and message again.</p></div>}
    {state.phase === "network_error" && <div className={styles.error} role="alert"><strong>Review unavailable</strong><p>{state.message}</p><p>No send was started from this screen. Reconnect and review again.</p></div>}
    {state.phase === "uncertain" && !state.status && <div className={styles.notice} role="alert"><strong>Send result not confirmed</strong><p>{state.message}</p><p>Do not resend. Check the conversation or receipt manually.</p></div>}
    {!sent && <><label className={styles.label} htmlFor={bulk ? "bulk-reply-message" : "single-reply-message"}>Message</label><textarea id={bulk ? "bulk-reply-message" : "single-reply-message"} className={styles.textarea} aria-label="Reply message" rows={3} maxLength={MAX_BODY} value={state.draft} disabled={reviewBusy || state.phase === "sending" || state.phase === "blocked"} onChange={event => dispatch({ type: "edit", draft: event.target.value })} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void reviewReply(); } }} placeholder="Write a reply…" />
      <div className={styles.footer}><span className={styles.counter}>{state.draft.length} / {MAX_BODY} characters{bulk ? ` · ${targets.length} selected` : ""}</span>{state.phase !== "reviewing" && state.phase !== "blocked" && state.phase !== "sending" && <button type="button" className={styles.primary} onClick={() => void reviewReply()} disabled={!state.draft.trim() || reviewBusy}>{reviewBusy ? "Checking…" : "Review reply"}</button>}</div></>}
    {reviewBusy && <p className={styles.notice} role="status">Checking current eligibility and recipient routes…</p>}
    {review && !sent && <PreparedReview prepared={review} names={names} onEdit={() => dispatch({ type: "edit", draft: state.draft })} onSend={() => void sendReply()} sending={state.phase === "sending"} bulk={bulk} />}
    {!review && state.message && state.phase === "blocked" && <p className={styles.error} role="alert">{state.message}</p>}
    {(state.status || state.operationId) && <ReceiptSummary status={state.status} operationId={state.operationId} bulk={bulk} sending={state.phase === "sending"} uncertainResult={state.phase === "uncertain"} message={state.message} />}
    {onClose && <button className={styles.secondary} type="button" onClick={onClose}>Close</button>}
  </section>;
}

export { receiptLabel, statusMessage };
