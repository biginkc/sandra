import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InboxOperationReceipt } from "@/components/inbox-workspace/operation-receipt";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inbox action receipt · Sandra CRM" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function InboxOperationReceiptPage({ params }: { params: Promise<{ operationId: string }> }) {
  const { operationId } = await params;
  if (!UUID.test(operationId)) notFound();
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) redirect("/login");
  return <InboxOperationReceipt operationId={operationId} kind="metadata" />;
}
