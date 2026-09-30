"use client";

import Link from "next/link";
import { useState } from "react";
import { InboxWorkspace, type WorkspaceRow } from "@/components/inbox-workspace/inbox-workspace";
import { ConversationHistory, type InboxDetailSnapshot } from "@/components/inbox-workspace/conversation-history";
import { workspaceId, type WorkspaceId } from "@/components/inbox-workspace/selection";
import { exclusionCopy } from "@/components/inbox-workspace/reply-composer";
import { fixture, previewStates, type InboxReplyPreviewState } from "./_fixtures";
import styles from "./preview.module.css";

const target = { kind: "conversation" as const, orgId: fixture.orgId, conversationId: fixture.conversationId };
const secondTarget = { kind: "conversation" as const, orgId: fixture.orgId, conversationId: fixture.secondConversationId };
const targetId = workspaceId(target);
const secondTargetId = workspaceId(secondTarget);
const rows: WorkspaceRow[] = [
  { target, name: fixture.name, context: fixture.property, preview: "I might be. What would a call involve?", timeLabel: "Today", outcomeLabel: "Needs outcome", assignedLabel: "—", unread: true },
  { target: secondTarget, name: fixture.secondName, context: fixture.secondProperty, preview: "Next week works better for me.", timeLabel: "Yesterday", outcomeLabel: "Needs outcome", assignedLabel: "—" },
  { target: { kind: "conversation", orgId: fixture.orgId, conversationId: "99999999-9999-4999-8999-999999999999" }, name: "Sofia Andrade", context: "Juniper Ave", preview: "Thanks for following up.", timeLabel: "Mon", outcomeLabel: "Needs outcome", assignedLabel: "—" },
];
const historySnapshot: InboxDetailSnapshot = { requesterId: fixture.requesterId, orgId: fixture.orgId, conversationId: fixture.conversationId, headRevision: "2", readBoundary: fixture.boundaryId, boundaryExpiresAt: "2099-01-01T00:00:00Z", captureGeneration: fixture.captureGeneration, history: [...fixture.history], nextCursor: null };
const fixtureRead: typeof fetch = async () => Response.json({ boundaryId: fixture.boundaryId, batch: 0, changed: 0, completed: true });
const href = (state: InboxReplyPreviewState) => `/brand/inbox/reply/${state}`;

function stateLabel(state: InboxReplyPreviewState): string { return state === "route-changed" ? "review discarded" : state.replaceAll("-", " "); }
function blockedCode(state: InboxReplyPreviewState): string | null { return state.startsWith("blocked-") ? state.slice("blocked-".length) : null; }

function Recipient({ name, property, from, to, body, state }: { name: string; property: string; from: string; to: string; body: string; state: InboxReplyPreviewState }) {
  const code = blockedCode(state);
  return <article className={`${styles.recipient} ${code ? styles.blocked : ""}`}><div className={styles.recipientHead}><div><strong>{name}</strong><small>{property}</small></div><span>{code ? "EXCLUDED" : "INCLUDED"}</span></div>{code ? <p className={styles.blockedCopy}>{exclusionCopy[code as keyof typeof exclusionCopy]}</p> : <><div className={styles.routeGrid}><div><small>From</small><strong>{from}</strong></div><div><small>To</small><strong>{to}</strong></div></div><p className={styles.body}>{body}</p></>}</article>;
}

function ReplyFixtureDock({ state }: { state: InboxReplyPreviewState }) {
  const code = blockedCode(state);
  const isBulk = state === "bulk-review" || state === "bulk-receipt";
  const reviewing = state === "reviewing" || state === "bulk-review";
  const sending = state === "sending";
  const sent = state === "sent" || state === "bulk-receipt";
  const uncertain = state === "uncertain";
  return <section className={`${styles.dock} ${isBulk ? styles.bulkDock : ""}`} aria-label={isBulk ? "Bulk reply review" : "Single reply composer"}><div className={styles.dockTop}><div><span className={styles.eyebrow}>{isBulk ? "BULK REPLY" : "SINGLE REPLY"} · FIXTURE</span><h3>{isBulk ? "Reply to 2 selected conversations" : `Reply to ${fixture.name}`}</h3></div><span className={`${styles.state} ${code || state === "route-changed" || uncertain || state === "network-error" ? styles.warning : sent ? styles.success : ""}`}>{stateLabel(state)}</span></div>
    {code && <div className={styles.notice} role="alert"><strong>Reply blocked · {code}</strong><p>{exclusionCopy[code as keyof typeof exclusionCopy]}</p><p>Eligibility must be checked again before a reply can be sent.</p></div>}
    {state === "route-changed" && <div className={styles.notice} role="alert"><strong>Review discarded</strong><p>The sending route or destination changed since this review.</p><p>Nothing was sent. Review the current route and message again.</p></div>}
    {state === "network-error" && <div className={styles.notice} role="alert"><strong>Review unavailable</strong><p>The network response was lost before this review completed.</p><p>Reconnect and review again. This screen does not claim that server work was unchanged.</p></div>}
    {uncertain && <div className={styles.notice} role="alert"><strong>Send result not confirmed</strong><p>The provider dispatch result is uncertain. Do not resend this reply.</p><p>Check the conversation and receipt manually.</p></div>}
    {sent && <div className={styles.receipt} role="status"><strong>{isBulk ? "Bulk receipt" : "Delivered"}</strong><p>{isBulk ? "Per-recipient receipts are available below. No resend is offered from a receipt." : "Delivered to the reviewed destination."}</p><ul>{[fixture.name, ...(isBulk ? [fixture.secondName] : [])].map(name => <li key={name}><span>{name}</span><strong>{uncertain ? "Result not confirmed" : "Delivered"}</strong></li>)}</ul></div>}
    {!sent && <><label className={styles.label} htmlFor="fixture-reply-message">Message</label><textarea id="fixture-reply-message" className={styles.textarea} defaultValue={fixture.body} disabled={Boolean(code || state === "route-changed" || state === "network-error" || uncertain || sending)} rows={4} /><div className={styles.footer}><span>{fixture.body.length} / 1600 characters · {isBulk ? "2 recipients" : "1 recipient"}</span>{state === "ready" && <Link className={styles.primary} href={href("reviewing")}>Review reply</Link>}{reviewing && <><Link className={styles.secondary} href={href("ready")}>Edit</Link><Link className={styles.primary} href={href(sending ? "sending" : "sent")}>{isBulk ? "Send to 2 recipients" : "Send reply"}</Link></>}{sending && <button className={styles.secondary} type="button" disabled>Sending…</button>}{(code || state === "route-changed" || state === "network-error") && <button className={styles.secondary} type="button" disabled>Send unavailable</button>}</div></>}
    {isBulk && <div className={styles.recipients}><Recipient name={fixture.name} property={fixture.property} from={fixture.from} to={fixture.to} body={fixture.body} state={state} /><Recipient name={fixture.secondName} property={fixture.secondProperty} from={fixture.secondFrom} to={fixture.secondTo} body={fixture.secondBody} state={state} /></div>}
    {!isBulk && (reviewing || sent) && <div className={styles.recipients}><Recipient name={fixture.name} property={fixture.property} from={fixture.from} to={fixture.to} body={fixture.body} state={state} /></div>}
  </section>;
}

export function InboxReplyPreview({ state }: { state: InboxReplyPreviewState }) {
  const [selected, setSelected] = useState<readonly WorkspaceId[]>(state === "bulk-review" || state === "bulk-receipt" ? [targetId, secondTargetId] : [targetId]);
  const [opened, setOpened] = useState(true);
  return <div className={styles.preview}><nav className={styles.previewNav} aria-label="Inbox reply fixture states"><strong>Sandra · Inbox</strong><div><span className={styles.fixtureTag}>NO AUTH · LOCAL FIXTURE</span>{previewStates.filter(value => !value.startsWith("blocked-")).map(value => <Link key={value} href={href(value)} aria-current={state === value ? "page" : undefined}>{stateLabel(value)}</Link>)}<label>Blocked <select aria-label="Blocked reason fixture" value={codeValue(state)} onChange={event => event.target.value && (window.location.href = href(event.target.value as InboxReplyPreviewState))}><option value="">Choose</option>{previewStates.filter(value => value.startsWith("blocked-")).map(value => <option key={value} value={value}>{stateLabel(value)}</option>)}</select></label></div></nav><InboxWorkspace scopeLabel="All" rows={rows} selectedIds={selected} openId={opened ? targetId : null} onSelectionChange={ids => setSelected(ids)} onOpen={id => { setOpened(true); if (id !== targetId) setSelected([id]); }} onCloseDetail={() => setOpened(false)} onBack={() => { window.location.href = href("ready"); }} onReviewSelection={() => {}} replyUiEnabled actions={[]} onBulkReply={() => {}} onAction={() => {}} connection={{ state: "live", label: "Fixture data · no live connection" }} toolbar={<><span>View <strong>All</strong></span><span>Selection stays in memory · no provider calls</span></>} pageControl={<span>3 fixture conversations</span>} detail={{ targetId, title: fixture.name, context: fixture.property, state: "ready", content: <div className={styles.detailBody}><div className={styles.history}><ConversationHistory orgId={fixture.orgId} conversationId={fixture.conversationId} requestGeneration={1} snapshot={{ requestGeneration: 1, data: historySnapshot }} visible onRefresh={() => {}} onAccessLost={() => {}} onUnavailable={() => {}} fetch={fixtureRead} /></div><ReplyFixtureDock state={state} /></div> }} activity={<p>Fixture data only. The production composer is mounted at the same detail edge.</p>} /></div>;
}

function codeValue(state: InboxReplyPreviewState): string { return state.startsWith("blocked-") ? state : ""; }
