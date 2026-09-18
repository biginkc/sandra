"use client";

import { useState, useTransition } from "react";
import { BookAppointmentPopover } from "@/components/appointments/book-appointment-popover";
import { AssignDropdown } from "@/app/(dashboard)/messages/assign-dropdown";
import {
  confirmAiDispositionReview,
  moveMessageThreadToLead,
  setOutreachDispo,
  type OutreachDispo,
} from "@/app/(dashboard)/messages/dispo-actions";
import type { InboxDetailSnapshot } from "./conversation-history";

export type InboxAiDispositionReview = {
  id: string;
  disposition: string;
  reason: string;
  sourceMessageBody?: string | null;
};

export type KnownConversationActionContext = {
  conversationId: string;
  propertyId: string | null;
  contactId: string | null;
  contactName: string | null;
  propertyAddress: string | null;
  propertyStatus: string | null;
  outreachDispo: string | null;
  assigneeId: string | null;
  assigneeLabel: string | null;
  currentPhone: string | null;
  isDncLocked: boolean;
  contactDoNotContact: boolean;
  aiDispositionReview: InboxAiDispositionReview | null;
  aiResponderStatus: string | null;
  aiResponderReason: string | null;
  aiLastDeliveryStatus: string | null;
  aiLastDeliveryError: string | null;
};

function stringOrNull(row: Record<string, unknown>, key: string): string | null {
  return typeof row[key] === "string" && row[key] ? row[key] as string : null;
}

/** Decode optional action fields without making the read history endpoint a
 * second authority. Older snapshots simply produce the link-only surface. */
export function knownConversationActionContext(
  data: InboxDetailSnapshot,
  fallbackName: string | null,
): KnownConversationActionContext {
  const row = data as unknown as Record<string, unknown>;
  const rawReview = row.aiDispositionReview;
  const review = rawReview && typeof rawReview === "object" && !Array.isArray(rawReview)
    ? rawReview as Record<string, unknown>
    : null;
  const aiDispositionReview = review && typeof review.id === "string" && typeof review.disposition === "string" && typeof review.reason === "string"
    ? { id: review.id, disposition: review.disposition, reason: review.reason, sourceMessageBody: typeof review.sourceMessageBody === "string" ? review.sourceMessageBody : null }
    : null;
  return {
    conversationId: data.conversationId,
    propertyId: stringOrNull(row, "propertyId"),
    contactId: stringOrNull(row, "contactId"),
    contactName: stringOrNull(row, "contactName") ?? fallbackName,
    propertyAddress: stringOrNull(row, "propertyAddress"),
    propertyStatus: stringOrNull(row, "propertyStatus"),
    outreachDispo: stringOrNull(row, "outreachDispo"),
    assigneeId: stringOrNull(row, "assigneeId"),
    assigneeLabel: stringOrNull(row, "assigneeLabel") ?? stringOrNull(row, "assigneeEmail"),
    currentPhone: stringOrNull(row, "threadCustomerPhone") ?? stringOrNull(row, "currentPhone"),
    isDncLocked: row.isDncLocked === true,
    contactDoNotContact: row.contactDoNotContact === true,
    aiDispositionReview,
    aiResponderStatus: stringOrNull(row, "aiResponderStatus"),
    aiResponderReason: stringOrNull(row, "aiResponderReason"),
    aiLastDeliveryStatus: stringOrNull(row, "aiLastDeliveryStatus"),
    aiLastDeliveryError: stringOrNull(row, "aiLastDeliveryError"),
  };
}

const DISPOSITION_OPTIONS: readonly [OutreachDispo, string][] = [
  ["wrong_number", "Wrong number"],
  ["bad_number", "Bad / disconnected #"],
  ["not_interested", "Not interested"],
  ["needs_sequence", "Needs sequence"],
  ["nurture", "Follow up"],
  ["opted_out", "SMS opt-out"],
];

const dispositionLabel = (value: string | null | undefined) =>
  DISPOSITION_OPTIONS.find(([key]) => key === value)?.[1] ?? value ?? "No outcome";

type Props = {
  context: KnownConversationActionContext;
  currentUserId: string;
  onChanged: () => void;
};

/**
 * Detail actions for known conversations. The component deliberately accepts
 * only server-derived IDs and safety fields. It reuses the existing
 * authorized individual actions and appointment picker instead of inventing a
 * second mutation surface for Inbox.
 */
export function InboxKnownConversationActions({ context, currentUserId, onChanged }: Props) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string>();
  const [correction, setCorrection] = useState<OutreachDispo>("nurture");
  const [reviewVisible, setReviewVisible] = useState(context.aiDispositionReview !== null);

  const canMutateProperty = Boolean(context.propertyId) && !context.isDncLocked && !pending;
  const canCall = Boolean(context.currentPhone) && !context.isDncLocked && !context.contactDoNotContact;
  const isLead = context.propertyStatus !== null && context.propertyStatus !== "prospect";

  function applyDisposition(disposition: OutreachDispo) {
    if (!context.propertyId || !canMutateProperty) return;
    startTransition(async () => {
      const result = await setOutreachDispo(context.propertyId!, disposition);
      if (!result.ok) { setStatus(result.error); return; }
      setStatus(`${dispositionLabel(disposition)} saved.`);
      onChanged();
    });
  }

  function promote() {
    if (!context.propertyId || !canMutateProperty || isLead) return;
    startTransition(async () => {
      const result = await moveMessageThreadToLead(context.propertyId!);
      if (!result.ok) { setStatus(result.error); return; }
      setStatus(result.alreadyQualified ? "Already a lead." : "Moved to lead.");
      onChanged();
    });
  }

  function confirmReview() {
    const review = context.aiDispositionReview;
    if (!review || pending) return;
    startTransition(async () => {
      const result = await confirmAiDispositionReview(review.id);
      if (!result.ok) { setStatus(result.error); return; }
      setReviewVisible(false);
      setStatus(result.status === "confirmed" ? "Sandra disposition confirmed." : "Sandra disposition was superseded by a newer change.");
      onChanged();
    });
  }

  function correctReview() {
    if (!context.propertyId || !context.aiDispositionReview || !canMutateProperty) return;
    startTransition(async () => {
      const result = await setOutreachDispo(context.propertyId!, correction);
      if (!result.ok) { setStatus(result.error); return; }
      setReviewVisible(false);
      setStatus(`Corrected to ${dispositionLabel(correction)}.`);
      onChanged();
    });
  }

  return (
    <section aria-label="Conversation actions" className="mt-4 space-y-4 rounded border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">Individual actions</h3>
        {context.propertyId && <AssignDropdown propertyId={context.propertyId} initialAssigneeId={context.assigneeId} initialAssigneeEmail={context.assigneeLabel} currentUserId={currentUserId} />}
        {context.propertyId && <button type="button" className="rounded border px-3 py-2 text-sm" disabled={!canMutateProperty || isLead} onClick={promote}>{isLead ? "Already a lead" : "Move to Lead"}</button>}
        {context.propertyId && <a className="rounded border px-3 py-2 text-sm" href={`/leads/${encodeURIComponent(context.propertyId)}`}>Open lead</a>}
        {canCall && <a className="rounded border px-3 py-2 text-sm" href={`tel:${context.currentPhone}`}>Call</a>}
        <a className="rounded border px-3 py-2 text-sm" href="/leads?compose=1">New message</a>
        {context.propertyId && <BookAppointmentPopover propertyId={context.propertyId} contactId={context.contactId ?? undefined} subjectLabel={context.propertyAddress ?? context.contactName ?? undefined} currentUserId={currentUserId} disabled={!canMutateProperty} triggerLabel="Book appointment" />}
      </div>

      {context.propertyId && <div className="flex flex-wrap items-center gap-2" aria-label="Disposition actions">
        <span className="text-sm font-medium">Outcome: {dispositionLabel(context.outreachDispo)}</span>
        {DISPOSITION_OPTIONS.slice(0, 5).map(([value, label]) => <button key={value} type="button" className="rounded border px-2 py-1 text-xs" disabled={!canMutateProperty} onClick={() => applyDisposition(value)}>{label}</button>)}
        <button type="button" className="rounded border px-2 py-1 text-xs" disabled={!canMutateProperty} onClick={() => applyDisposition("opted_out")}>SMS opt-out</button>
      </div>}

      {(context.aiResponderStatus || context.aiLastDeliveryStatus || context.aiLastDeliveryError) && <div role="region" aria-label="Sandra AI status" className="rounded bg-muted/40 p-2 text-sm"><strong>Sandra AI</strong><p>{context.aiResponderStatus ? `Status: ${context.aiResponderStatus}` : "No active responder status"}{context.aiResponderReason ? ` · ${context.aiResponderReason}` : ""}</p>{context.aiLastDeliveryStatus && <p>Last delivery: {context.aiLastDeliveryStatus}</p>}{context.aiLastDeliveryError && <p role="alert">Delivery issue: {context.aiLastDeliveryError}</p>}</div>}

      {context.aiDispositionReview && reviewVisible && <div role="region" aria-label="Sandra disposition review" className="rounded border border-orange-300 bg-orange-50 p-3"><p className="font-medium">Sandra suggested: {dispositionLabel(context.aiDispositionReview.disposition)}</p><p className="text-sm">Why: {context.aiDispositionReview.reason}</p>{context.aiDispositionReview.sourceMessageBody && <blockquote className="mt-1 border-l-2 pl-2 text-sm">“{context.aiDispositionReview.sourceMessageBody}”</blockquote>}<div className="mt-2 flex flex-wrap items-center gap-2"><button type="button" className="rounded border px-3 py-2 text-sm" disabled={pending} onClick={confirmReview}>Confirm Sandra disposition</button><label className="text-sm">Correct to <select aria-label="Correct Sandra disposition" value={correction} disabled={pending || !canMutateProperty} onChange={event => setCorrection(event.target.value as OutreachDispo)}>{DISPOSITION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button type="button" className="rounded border px-3 py-2 text-sm" disabled={pending || !canMutateProperty} onClick={correctReview}>Save correction</button></div></div>}

      {status && <p role="status">{status}</p>}
      {context.isDncLocked && <p role="note">This property is permanently locked; mutation controls are disabled.</p>}
    </section>
  );
}
