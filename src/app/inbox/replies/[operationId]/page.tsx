import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InboxReplyReceipt } from "@/components/inbox-workspace/reply-receipt";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inbox reply receipt · Sandra CRM" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function InboxReplyReceiptPage({ params }: { params: Promise<{ operationId: string }> }) {
  const { operationId } = await params;
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1" || process.env.INBOX_REPLIES_SERVER_ENABLED !== "1" || !UUID.test(operationId)) notFound();
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) redirect("/login");
  return <InboxReplyReceipt operationId={operationId} />;
}
