import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createSupabaseInboxRepository, type InboxRpcClient } from "@/lib/inbox/supabase-sync-repository";
import { InboxOverview } from "@/components/inbox-workspace/inbox-overview";
export const dynamic = "force-dynamic";
export const metadata = { title: "Inbox overview · Sandra CRM" };
export default async function InboxOverviewPage() {
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") notFound();
  let context;
  try {
    const client = await createClient();
    context = await createSupabaseInboxRepository(client as unknown as InboxRpcClient).getContext(AbortSignal.timeout(15000));
  } catch { /* Fail closed without modifying the existing Messages page. */ }
  if (!context) return <main><h1>Inbox overview unavailable</h1><p>Your current access could not be verified.</p><a href="/messages">Back to Messages</a></main>;
  return <InboxOverview key={`${context.orgId}:${context.userId}:${context.sessionId}:${context.accessEpoch}`} identity={context} />;
}
