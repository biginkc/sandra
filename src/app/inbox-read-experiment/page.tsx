import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSingleActiveMembership } from "@/lib/auth/memberships";
import { listThreadPage } from "@/lib/messages/list-threads";
import { ReadExperiment } from "./read-experiment";

export default async function InboxReadExperimentPage() {
  if (process.env.INBOX_V2_EXPERIMENT_ENABLED !== "1") notFound();
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) redirect("/login");
  const membership = await getSingleActiveMembership();
  if (!membership.ok || membership.membership.user_id !== data.user.id) notFound();
  const page = await listThreadPage(client, {
    filter: "all", currentUserId: data.user.id, includeThreadId: null,
    hideNoise: true, page: 1, pageSize: 200,
  });
  return <ReadExperiment key={`${data.user.id}:${membership.membership.org_id}`}
    rows={page.threads.map(thread => ({ id: thread.threadId, name: thread.contactName,
      address: thread.propertyAddress, preview: thread.lastMessageBody }))} />;
}
