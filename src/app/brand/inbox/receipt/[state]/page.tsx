import { notFound } from "next/navigation";
import { InboxReplyReceiptPreview, type InboxReplyReceiptPreviewState } from "../../_receipt-preview-shell";

const states: InboxReplyReceiptPreviewState[] = ["sending", "delivered", "not-confirmed"];

export function generateStaticParams() {
  return states.map(state => ({ state }));
}

export default async function InboxReplyReceiptPreviewPage({ params }: { params: Promise<{ state: string }> }) {
  const { state } = await params;
  if (!states.includes(state as InboxReplyReceiptPreviewState)) notFound();
  return <InboxReplyReceiptPreview state={state as InboxReplyReceiptPreviewState} />;
}
