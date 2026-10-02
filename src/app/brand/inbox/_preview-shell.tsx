"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { InboxWorkspace, type WorkspaceRow } from "@/components/inbox-workspace/inbox-workspace";
import { ConversationHistory, type InboxDetailSnapshot } from "@/components/inbox-workspace/conversation-history";
import { PreviewInboxReplyComposer } from "@/components/inbox-workspace/reply-composer";
import { workspaceId, type WorkspaceId } from "@/components/inbox-workspace/selection";
import { INBOX_REPLY_TERMINAL_RECEIPT_STATES, type InboxReplyStatus, type InboxReplyTarget, type PreparedInboxReply, type PreparedInboxReplyItem } from "@/lib/inbox/reply-api-contract";
import type { ReplyState } from "@/components/inbox-workspace/reply-state-machine";
import { fixture, previewStates, type InboxReplyPreviewState } from "./_fixtures";
import styles from "./preview.module.css";

const target = { kind: "conversation" as const, id: fixture.conversationId };
const secondTarget = { kind: "conversation" as const, id: fixture.secondConversationId };
const targetRow = { kind: "conversation" as const, orgId: fixture.orgId, conversationId: fixture.conversationId };
const secondTargetRow = { kind: "conversation" as const, orgId: fixture.orgId, conversationId: fixture.secondConversationId };
const targetId = workspaceId(targetRow);
const secondTargetId = workspaceId(secondTargetRow);
const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const preparationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const itemIds = ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"] as const;

const rows: WorkspaceRow[] = [
  { target: targetRow, name: fixture.name, context: fixture.property, preview: "I might be. What would a call involve?", timeLabel: "Today", outcomeLabel: "Needs outcome", assignedLabel: "—", unread: true },
  { target: secondTargetRow, name: fixture.secondName, context: fixture.secondProperty, preview: "Next week works better for me.", timeLabel: "Yesterday", outcomeLabel: "Needs outcome", assignedLabel: "—" },
  { target: { kind: "conversation", orgId: fixture.orgId, conversationId: "99999999-9999-4999-8999-999999999999" }, name: "Sofia Andrade", context: "Juniper Ave", preview: "Thanks for following up.", timeLabel: "Mon", outcomeLabel: "Needs outcome", assignedLabel: "—" },
];

const historySnapshot: InboxDetailSnapshot = { requesterId: fixture.requesterId, orgId: fixture.orgId, conversationId: fixture.conversationId, propertyId: "ffffffff-ffff-4fff-8fff-ffffffffffff", headRevision: "2", readBoundary: fixture.boundaryId, boundaryExpiresAt: "2099-01-01T00:00:00Z", captureGeneration: fixture.captureGeneration, history: [...fixture.history], nextCursor: null };
const fixtureRead: typeof fetch = async () => Response.json({ boundaryId: fixture.boundaryId, batch: 0, changed: 0, completed: true });
const href = (state: InboxReplyPreviewState) => `/brand/inbox/reply/${state}`;

function stateLabel(state: InboxReplyPreviewState): string { return state === "route-changed" ? "review discarded" : state.replaceAll("-", " "); }
function blockedCode(state: InboxReplyPreviewState): string | null { return state.startsWith("blocked-") ? state.slice("blocked-".length) : null; }
function isBulkState(state: InboxReplyPreviewState): boolean { return state === "bulk-review" || state === "bulk-receipt"; }

function previewItem(itemId: string, itemTarget: InboxReplyTarget, state: InboxReplyPreviewState, index: number): PreparedInboxReplyItem {
  const code = blockedCode(state);
  if (code) return { id: itemId, target: itemTarget, exclusion: code as PreparedInboxReplyItem["exclusion"], recipient: null, duplicateDestination: false };
  const isSecond = index === 1;
  return {
    id: itemId,
    target: itemTarget,
    exclusion: null,
    duplicateDestination: false,
    recipient: {
      contactName: isSecond ? fixture.secondName : fixture.name,
      propertyAddress: isSecond ? fixture.secondProperty : fixture.property,
      propertyId: isSecond ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" : "ffffffff-ffff-4fff-8fff-ffffffffffff",
      contactId: isSecond ? "99999999-9999-4999-8999-999999999998" : fixture.requesterId,
      from: isSecond ? fixture.secondFrom : fixture.from,
      to: isSecond ? fixture.secondTo : fixture.to,
      renderedBody: isSecond ? fixture.secondBody : fixture.body,
    },
  };
}

function preparedFor(state: InboxReplyPreviewState, targets: readonly InboxReplyTarget[], idempotencyKey: string): PreparedInboxReply {
  const items = targets.map((value, index) => previewItem(itemIds[index] ?? itemIds[0], value, state, index));
  const blocked = blockedCode(state);
  return {
    preparationId,
    idempotencyKey,
    inputHash: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    items,
    recipientCount: blocked ? 0 : items.length,
    blockers: blocked ? ["empty"] : [],
  };
}

function statusFor(prepared: PreparedInboxReply, receiptState: InboxReplyStatus["receipts"][number]["state"]): InboxReplyStatus {
  const receipts = prepared.items.map(item => ({ itemId: item.id, attemptId: null, version: "1", state: item.exclusion ? "blocked" as const : receiptState, reason: null }));
  return {
    operationId,
    preparationId: prepared.preparationId,
    dispatchComplete: receipts.every(receipt => INBOX_REPLY_TERMINAL_RECEIPT_STATES.includes(receipt.state as typeof INBOX_REPLY_TERMINAL_RECEIPT_STATES[number])),
    items: prepared.items,
    receipts,
  };
}

function previewInitialState(state: InboxReplyPreviewState, targets: readonly InboxReplyTarget[], routeKey: string): ReplyState {
  const prepared = preparedFor(state, targets, "fixture-idempotency-key");
  const review = { prepared, routeKey };
  const draft = fixture.body;
  if (state === "ready") return { phase: "ready", draft };
  if (state === "checking") return { phase: "reviewing", draft };
  if (state === "reviewing" || state === "bulk-review") return { phase: "reviewing", draft, review };
  if (state === "sending") return { phase: "sending", draft, review, operationId, status: statusFor(prepared, "pending") };
  if (state === "sent" || state === "bulk-receipt") return { phase: "sending", draft, operationId, status: statusFor(prepared, "delivered") };
  if (state === "receipt-blocked") return { phase: "sending", draft, operationId, status: statusFor(prepared, "blocked") };
  if (state === "receipt-confirmed-not-submitted") return { phase: "sending", draft, operationId, status: statusFor(prepared, "confirmed_not_submitted") };
  if (state === "uncertain") return { phase: "uncertain", draft, operationId, status: statusFor(prepared, "uncertain"), message: "The provider result is not yet confirmed. Do not resend this reply." };
  if (state === "route-changed") return { phase: "route_changed", draft, message: "The sending route changed. Review the current route before sending." };
  if (state === "network-error") return { phase: "network_error", draft, message: "Fixture network unavailable" };
  return { phase: "blocked", draft, review, message: "No eligible recipients remain in this review." };
}

export function InboxReplyPreview({ state }: { state: InboxReplyPreviewState }) {
  useEffect(() => {
    document.body.dataset.sandraInboxPreview = "true";
    const devBadgeStyle = document.createElement("style");
    devBadgeStyle.dataset.sandraInboxPreview = "true";
    devBadgeStyle.textContent = "body[data-sandra-inbox-preview] script[data-nextjs-dev-overlay] > nextjs-portal { display: none !important; }";
    document.head.appendChild(devBadgeStyle);

    return () => {
      delete document.body.dataset.sandraInboxPreview;
      devBadgeStyle.remove();
    };
  }, []);

  const bulk = isBulkState(state);
  const [selected, setSelected] = useState<readonly WorkspaceId[]>(bulk ? [targetId, secondTargetId] : [targetId]);
  const [openedId, setOpenedId] = useState<WorkspaceId | null>(targetId);
  const [bulkOpen, setBulkOpen] = useState(bulk);
  const openedTarget = openedId === secondTargetId ? secondTarget : target;
  const replyTargets = useMemo(() => bulk ? [target, secondTarget] : [openedTarget], [bulk, openedTarget]);
  const names = useMemo(() => new Map([[`${target.kind}:${target.id}`, fixture.name], [`${secondTarget.kind}:${secondTarget.id}`, fixture.secondName]]), []);
  const detailRouteKey = fixture.captureGeneration;
  const bulkRouteKey = `${target.kind}:${target.id}|${secondTarget.kind}:${secondTarget.id}`;
  const detailInitialState = useMemo(() => previewInitialState(isBulkState(state) ? "ready" : state, [openedTarget], detailRouteKey), [detailRouteKey, openedTarget, state]);
  const bulkInitialState = useMemo(() => previewInitialState(state, replyTargets, bulkRouteKey), [bulkRouteKey, replyTargets, state]);
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/replies/prepare")) {
      if (state === "checking") return new Promise<Response>(() => {});
      if (state === "network-error") throw Error("Fixture network unavailable");
      const body = JSON.parse(String(init?.body)) as { idempotencyKey: string; targets: readonly InboxReplyTarget[] };
      return Response.json(preparedFor(state, body.targets, body.idempotencyKey));
    }
    if (url.endsWith("/replies/accept")) {
      if (state === "sending") return new Promise<Response>(() => {});
      return Response.json({ operationId });
    }
    if (url.includes("/replies/")) {
      const prepared = preparedFor(state, replyTargets, "fixture-idempotency-key");
      const receiptState = state === "uncertain"
        ? "uncertain"
        : state === "receipt-blocked"
          ? "blocked"
          : state === "receipt-confirmed-not-submitted"
            ? "confirmed_not_submitted"
            : "delivered";
      return Response.json(statusFor(prepared, receiptState));
    }
    return Response.json({ boundaryId: fixture.boundaryId, batch: 0, changed: 0, completed: true });
  };

  const detailContent = openedId ? <div className={styles.detailBody}>
    <div className={styles.history}><ConversationHistory orgId={fixture.orgId} conversationId={openedTarget.id} requestGeneration={1} snapshot={{ requestGeneration: 1, data: { ...historySnapshot, conversationId: openedTarget.id } }} visible onRefresh={() => {}} onAccessLost={() => {}} onUnavailable={() => {}} fetch={fixtureRead} /></div>
    <PreviewInboxReplyComposer targets={[openedTarget]} names={names} routeKey={detailRouteKey} enabled fetcher={fixtureFetch} initialDraft={fixture.body} initialState={detailInitialState} />
  </div> : undefined;

  return <div className={styles.preview}>
    <nav className={styles.previewNav} aria-label="Inbox reply fixture states"><strong>Sandra · Inbox</strong><div><span className={styles.fixtureTag}>NO AUTH · LOCAL FIXTURE FETCH</span>{previewStates.filter(value => !value.startsWith("blocked-")).map(value => <Link key={value} href={href(value)} aria-current={state === value ? "page" : undefined}>{stateLabel(value)}</Link>)}<label>Blocked <select aria-label="Blocked reason fixture" value={blockedCode(state) ? state : ""} onChange={event => event.target.value && (window.location.href = href(event.target.value as InboxReplyPreviewState))}><option value="">Choose</option>{previewStates.filter(value => value.startsWith("blocked-")).map(value => <option key={value} value={value}>{stateLabel(value)}</option>)}</select></label></div></nav>
    <InboxWorkspace scopeLabel="All" rows={rows} selectedIds={selected} openId={openedId} onSelectionChange={ids => { setSelected(ids); if (ids.length < 2) setBulkOpen(false); }} onOpen={id => setOpenedId(id)} onCloseDetail={() => setOpenedId(null)} onBack={() => { window.location.href = href("ready"); }} onReviewSelection={() => {}} replyUiEnabled onBulkReply={() => setBulkOpen(true)} onAction={() => {}} actions={[]} connection={{ state: "live", label: "Fixture data · no live connection" }} toolbar={<><span>View <strong>All</strong></span><span>Selection stays in memory · no provider calls</span></>} pageControl={<span>3 fixture conversations</span>} detail={openedId ? { targetId: openedId, title: openedId === secondTargetId ? fixture.secondName : fixture.name, context: openedId === secondTargetId ? fixture.secondProperty : fixture.property, state: "ready", content: detailContent } : undefined} />
    <Dialog open={bulkOpen && bulk} onOpenChange={setBulkOpen}><DialogContent data-preview-bulk-dialog className="max-h-[85dvh] overflow-auto"><DialogTitle>Bulk reply review</DialogTitle><DialogDescription>Every destination is fixture data. The real composer is using a local fetch stub; no provider call or message send occurs.</DialogDescription><PreviewInboxReplyComposer targets={replyTargets} names={names} routeKey={bulkRouteKey} enabled fetcher={fixtureFetch} initialDraft={fixture.body} initialState={bulkInitialState} onClose={() => setBulkOpen(false)} /></DialogContent></Dialog>
  </div>;
}
