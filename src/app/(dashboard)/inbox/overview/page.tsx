import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createSupabaseInboxRepository, type InboxRpcClient } from "@/lib/inbox/supabase-sync-repository";
import { InboxOverview } from "@/components/inbox-workspace/inbox-overview";
import { isInboxPilotRequest, type InboxPilotAuthClient } from "@/lib/inbox/pilot-cohort";
export const dynamic = "force-dynamic";
export const metadata = { title: "Inbox overview · Sandra CRM" };
export default async function InboxOverviewPage() {
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") notFound();
  const client = await createClient();
  // GL-4/G5: cohort gate before any inbox_* RPC, kept outside the try below
  // so notFound() is never swallowed as "unavailable".
  if (!(await isInboxPilotRequest(client as unknown as InboxPilotAuthClient))) notFound();
  let context;
  try {
    context = await createSupabaseInboxRepository(client as unknown as InboxRpcClient).getContext(AbortSignal.timeout(15000));
  } catch { /* Fail closed without modifying the existing Messages page. */ }
  if (!context) return <main><h1>Inbox overview unavailable</h1><p>Your current access could not be verified.</p><a href="/messages">Back to Messages</a></main>;
  return <InboxOverview key={`${context.orgId}:${context.userId}:${context.sessionId}:${context.accessEpoch}`} identity={context} />;
}
