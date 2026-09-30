"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { InboxWorkspace, type WorkspaceRow } from "@/components/inbox-workspace/inbox-workspace";
import { ConversationHistory, type InboxDetailSnapshot } from "@/components/inbox-workspace/conversation-history";
import { InboxReplyComposer } from "@/components/inbox-workspace/reply-composer";
import { workspaceId, type WorkspaceId } from "@/components/inbox-workspace/selection";
import type { InboxReplyStatus, InboxReplyTarget, PreparedInboxReply, PreparedInboxReplyItem } from "@/lib/inbox/reply-api-contract";
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

const historySnapshot: InboxDetailSnapshot = { requesterId: fixture.requesterId, orgId: fixture.orgId, conversationId: fixture.conversationId, headRevision: "2", readBoundary: fixture.boundaryId, boundaryExpiresAt: "2099-01-01T00:00:00Z", captureGeneration: fixture.captureGeneration, history: [...fixture.history], nextCursor: null };
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
  return {
    operationId,
    preparationId: prepared.preparationId,
    dispatchComplete: true,
    items: prepared.items,
    receipts: prepared.items.map(item => ({ itemId: item.id, attemptId: null, version: "1", state: item.exclusion ? "blocked" : receiptState, reason: null })),
  };
}

export function InboxReplyPreview({ state }: { state: InboxReplyPreviewState }) {
  const bulk = isBulkState(state);
  const [selected, setSelected] = useState<readonly WorkspaceId[]>(bulk ? [targetId, secondTargetId] : [targetId]);
  const [openedId, setOpenedId] = useState<WorkspaceId | null>(targetId);
  const [bulkOpen, setBulkOpen] = useState(bulk);
  const [routeVersion, setRouteVersion] = useState(0);
  const openedTarget = openedId === secondTargetId ? secondTarget : target;
  const replyTargets = bulk ? [target, secondTarget] : [openedTarget];
  const names = useMemo(() => new Map([[`${target.kind}:${target.id}`, fixture.name], [`${secondTarget.kind}:${secondTarget.id}`, fixture.secondName]]), []);
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
      return Response.json(statusFor(prepared, state === "uncertain" ? "uncertain" : "delivered"));
    }
    return Response.json({ boundaryId: fixture.boundaryId, batch: 0, changed: 0, completed: true });
  };

  useEffect(() => {
    if (state === "ready" || (state === "bulk-review" && !bulkOpen)) return;
    const rootSelector = bulk ? "[data-preview-bulk-dialog]" : undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const click = (label: string) => {
      const root = rootSelector ? document.querySelector(rootSelector) : document;
      const button = [...(root?.querySelectorAll("button") ?? [])].find(value => value.textContent?.trim() === label);
      button?.click();
    };
    timers.push(setTimeout(() => click("Review reply"), 80));
    if (["sent", "uncertain", "sending", "bulk-receipt"].includes(state)) {
      timers.push(setTimeout(() => click(bulk ? "Send to 2 recipients" : "Send reply"), 260));
    }
    if (state === "route-changed") timers.push(setTimeout(() => setRouteVersion(1), 260));
    return () => timers.forEach(clearTimeout);
  }, [bulk, bulkOpen, state]);

  const detailContent = openedId ? <div className={styles.detailBody}>
    <div className={styles.history}><ConversationHistory orgId={fixture.orgId} conversationId={openedTarget.id} requestGeneration={1} snapshot={{ requestGeneration: 1, data: { ...historySnapshot, conversationId: openedTarget.id } }} visible onRefresh={() => {}} onAccessLost={() => {}} onUnavailable={() => {}} fetch={fixtureRead} /></div>
    <InboxReplyComposer targets={[openedTarget]} names={names} routeKey={`${fixture.captureGeneration}:${routeVersion}`} enabled fetcher={fixtureFetch} initialDraft={fixture.body} />
  </div> : undefined;

  return <div className={styles.preview}>
    <nav className={styles.previewNav} aria-label="Inbox reply fixture states"><strong>Sandra · Inbox</strong><div><span className={styles.fixtureTag}>NO AUTH · LOCAL FIXTURE FETCH</span>{previewStates.filter(value => !value.startsWith("blocked-")).map(value => <Link key={value} href={href(value)} aria-current={state === value ? "page" : undefined}>{stateLabel(value)}</Link>)}<label>Blocked <select aria-label="Blocked reason fixture" value={blockedCode(state) ? state : ""} onChange={event => event.target.value && (window.location.href = href(event.target.value as InboxReplyPreviewState))}><option value="">Choose</option>{previewStates.filter(value => value.startsWith("blocked-")).map(value => <option key={value} value={value}>{stateLabel(value)}</option>)}</select></label></div></nav>
    <InboxWorkspace scopeLabel="All" rows={rows} selectedIds={selected} openId={openedId} onSelectionChange={ids => { setSelected(ids); if (ids.length < 2) setBulkOpen(false); }} onOpen={id => setOpenedId(id)} onCloseDetail={() => setOpenedId(null)} onBack={() => { window.location.href = href("ready"); }} onReviewSelection={() => {}} replyUiEnabled onBulkReply={() => setBulkOpen(true)} onAction={() => {}} actions={[]} connection={{ state: "live", label: "Fixture data · no live connection" }} toolbar={<><span>View <strong>All</strong></span><span>Selection stays in memory · no provider calls</span></>} pageControl={<span>3 fixture conversations</span>} detail={openedId ? { targetId: openedId, title: openedId === secondTargetId ? fixture.secondName : fixture.name, context: openedId === secondTargetId ? fixture.secondProperty : fixture.property, state: "ready", content: detailContent } : undefined} />
    <Dialog open={bulkOpen && bulk} onOpenChange={setBulkOpen}><DialogContent data-preview-bulk-dialog className="max-h-[85dvh] overflow-auto"><DialogTitle>Bulk reply review</DialogTitle><DialogDescription>Every destination is fixture data. The real composer is using a local fetch stub; no provider call or message send occurs.</DialogDescription><InboxReplyComposer targets={replyTargets} names={names} routeKey={replyTargets.map(value => `${value.kind}:${value.id}`).sort().join("|")} enabled fetcher={fixtureFetch} initialDraft={fixture.body} onClose={() => setBulkOpen(false)} /></DialogContent></Dialog>
  </div>;
}
