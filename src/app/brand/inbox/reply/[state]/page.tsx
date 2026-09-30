import { notFound } from "next/navigation";
import { isPreviewState, previewStates } from "../../_fixtures";
import { InboxReplyPreview } from "../../_preview-shell";

export function generateStaticParams() { return previewStates.map(state => ({ state })); }

export default async function InboxReplyPreviewPage({ params }: { params: Promise<{ state: string }> }) {
  const { state } = await params;
  if (!isPreviewState(state)) notFound();
  return <InboxReplyPreview state={state} />;
}
