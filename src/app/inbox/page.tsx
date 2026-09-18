import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createSupabaseInboxRepository, type InboxRpcClient } from "@/lib/inbox/supabase-sync-repository";
import { InboxWorkspaceClient } from "@/components/inbox-workspace/workspace-client";
import { inboxViews } from "@/lib/inbox/filter-contract";
import { isInboxPilotRequest, type InboxPilotAuthClient } from "@/lib/inbox/pilot-cohort";
import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { canAccessMessagesAndLeadsBoard } from "@/lib/auth/surface-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inbox workspace · Sandra CRM" };

export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") notFound();
  const params = await searchParams;
  const view = typeof params.view === "string" && (inboxViews as readonly string[]).includes(params.view) ? params.view as typeof inboxViews[number] : "all";
  const client = await createClient();
  // The inbox workspace reads the same shared message surface as Messages.
  // Enforce that boundary before the pilot check or canonical inbox RPC.
  if (!canAccessMessagesAndLeadsBoard(await getCallerMembershipsOrThrow())) notFound();
  // GL-4/G5: cohort gate before any inbox_* RPC. Outside the try below so
  // notFound()'s control-flow throw is never swallowed as "unavailable" —
  // a user outside the pilot allowlist gets the same not-found treatment
  // as flag-off, and getContext() (an inbox_* RPC) is never called.
  if (!(await isInboxPilotRequest(client as unknown as InboxPilotAuthClient))) notFound();
  let context;
  try {
    context = await createSupabaseInboxRepository(client as unknown as InboxRpcClient).getContext(AbortSignal.timeout(15_000));
  } catch { /* Missing schema or canonical access remains unavailable. */ }
  if (!context) return <main><h1>Inbox workspace unavailable</h1><p>Your current access could not be verified. Return to Messages or reload to try again.</p><a href="/messages">Back to Messages</a></main>;
  return <InboxWorkspaceClient key={`${context.orgId}:${context.userId}:${context.sessionId}:${context.accessEpoch}`} identity={context} actionsEnabled={process.env.INBOX_ACTIONS_SERVER_ENABLED === "1"} replyEnabled={process.env.INBOX_REPLIES_SERVER_ENABLED === "1"} initialFilter={{ view, hide_noise: true }} />;
}
