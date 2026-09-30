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

export type InboxReplyReceiptPreviewState = "sending" | "delivered" | "not-confirmed";

const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const itemId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function statusFor(state: InboxReplyReceiptPreviewState): InboxReplyStatus {
  const receiptState = state === "delivered" ? "delivered" : "dispatch_started";
  const receipt = { itemId, attemptId: null, version: "1", state: receiptState as InboxReplyStatus["receipts"][number]["state"], reason: null };
  return {
    operationId,
    preparationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    dispatchComplete: state === "delivered",
    items: [{
      id: itemId,
      target: { kind: "conversation", id: fixture.conversationId },
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
    }],
    receipts: [receipt],
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
      {(["sending", "delivered", "not-confirmed"] as const).map(value => <Link key={value} className="rounded border bg-white px-3 py-2" href={`/brand/inbox/receipt/${value}`} aria-current={state === value ? "page" : undefined}>{value.replaceAll("-", " ")}</Link>)}
    </nav>
    <PreviewInboxReplyReceipt operationId={operationId} fetcher={fetcher} initialFingerprint={initialFingerprint} initialTrackerAgeMs={MAX_POLL_DURATION_MS} />
  </main>;
}
