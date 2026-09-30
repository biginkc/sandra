"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import type { InboxReplyStatus } from "@/lib/inbox/reply-api-contract";
import {
  MAX_POLL_DURATION_MS,
  receiptProgressFingerprint,
} from "@/components/inbox-workspace/reply-receipt-policy";
import { PreviewInboxReplyReceipt } from "@/components/inbox-workspace/reply-receipt";
import { fixture } from "./_fixtures";

export type InboxReplyReceiptPreviewState = "sending" | "delivered" | "not-confirmed" | "provider-accepted" | "blocked" | "uncertain" | "mixed-bulk";

const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const itemId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function statusFor(state: InboxReplyReceiptPreviewState): InboxReplyStatus {
  const isMixed = state === "mixed-bulk";
  const items = isMixed ? [
    {
      id: itemId,
      target: { kind: "conversation" as const, id: fixture.conversationId },
      exclusion: null,
      duplicateDestination: false,
      recipient: {
        contactName: fixture.name,
        propertyAddress: fixture.property,
        propertyId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        contactId: fixture.requesterId,
        from: fixture.from,
        to: fixture.to,
        renderedBody: fixture.body,
      },
    },
    {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      target: { kind: "conversation" as const, id: fixture.secondConversationId },
      exclusion: null,
      duplicateDestination: false,
      recipient: {
        contactName: fixture.secondName,
        propertyAddress: fixture.secondProperty,
        propertyId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        contactId: "99999999-9999-4999-8999-999999999998",
        from: fixture.secondFrom,
        to: fixture.secondTo,
        renderedBody: fixture.secondBody,
      },
    },
    {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      target: { kind: "conversation" as const, id: "99999999-9999-4999-8999-999999999999" },
      exclusion: null,
      duplicateDestination: false,
      recipient: {
        contactName: "Sofia Andrade",
        propertyAddress: "Juniper Ave",
        propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contactId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        from: fixture.from,
        to: "+18165550144",
        renderedBody: "Hi Sofia, thanks for getting back about Juniper Ave.",
      },
    },
    {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      target: { kind: "conversation" as const, id: "77777777-7777-4777-8777-777777777777" },
      exclusion: null,
      duplicateDestination: false,
      recipient: {
        contactName: "Jordan Kim",
        propertyAddress: "Willowbend Rd",
        propertyId: "12121212-1212-4121-8121-121212121212",
        contactId: "13131313-1313-4131-8131-131313131313",
        from: fixture.secondFrom,
        to: "+18165550145",
        renderedBody: "Hi Jordan, thanks for getting back about Willowbend Rd.",
      },
    },
  ] : [{
    id: itemId,
    target: { kind: "conversation" as const, id: fixture.conversationId },
    exclusion: null,
    duplicateDestination: false,
    recipient: {
      contactName: fixture.name,
      propertyAddress: fixture.property,
      propertyId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      contactId: fixture.requesterId,
      from: fixture.from,
      to: fixture.to,
      renderedBody: fixture.body,
    },
  }];
  const receiptStates = isMixed
    ? ["delivered", "uncertain", "blocked", "pending"] as const
    : [state === "delivered" ? "delivered" : state === "provider-accepted" ? "provider_accepted" : state === "blocked" ? "blocked" : state === "uncertain" ? "uncertain" : "dispatch_started"] as const;
  const receiptItems = items.filter(item => item.exclusion === null);
  const receipts = receiptItems.map((item, index) => ({ itemId: item.id, attemptId: null, version: "1", state: receiptStates[index]!, reason: receiptStates[index] === "uncertain" ? "reentered_without_result" : receiptStates[index] === "blocked" ? "outside_window" : null }));
  return {
    operationId,
    preparationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    dispatchComplete: state === "delivered" || state === "provider-accepted",
    items,
    receipts,
  };
}

export function InboxReplyReceiptPreview({ state }: { state: InboxReplyReceiptPreviewState }) {
  useEffect(() => {
    document.body.dataset.sandraInboxPreview = "true";
    const style = document.createElement("style");
    style.dataset.sandraInboxPreview = "true";
    style.textContent = "body[data-sandra-inbox-preview] script[data-nextjs-dev-overlay] > nextjs-portal { display: none !important; }";
    document.head.appendChild(style);
    return () => {
      delete document.body.dataset.sandraInboxPreview;
      style.remove();
    };
  }, []);

  const fixtureStatus = useMemo(() => statusFor(state), [state]);
  const fetcher = useMemo<typeof fetch>(() => async () => Response.json(fixtureStatus), [fixtureStatus]);
  const initialFingerprint = state === "not-confirmed" ? receiptProgressFingerprint(fixtureStatus) : undefined;

  return <main className="min-h-screen bg-slate-50 p-4 sm:p-8">
    <nav className="mx-auto mb-4 flex max-w-4xl flex-wrap gap-3 text-sm" aria-label="Receipt fixture states">
      <strong className="mr-auto text-slate-700">Sandra · receipt fixture</strong>
    {(["sending", "delivered", "not-confirmed", "provider-accepted", "blocked", "uncertain", "mixed-bulk"] as const).map(value => <Link key={value} className="rounded border bg-white px-3 py-2" href={`/brand/inbox/receipt/${value}`} aria-current={state === value ? "page" : undefined}>{value.replaceAll("-", " ")}</Link>)}
    </nav>
    <PreviewInboxReplyReceipt operationId={operationId} fetcher={fetcher} initialFingerprint={initialFingerprint} initialTrackerAgeMs={MAX_POLL_DURATION_MS} />
  </main>;
}
