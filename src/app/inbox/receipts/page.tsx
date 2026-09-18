import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createSupabaseInboxRepository, type InboxRpcClient } from "@/lib/inbox/supabase-sync-repository";
import { InboxReceiptRecovery } from "@/components/inbox-workspace/receipt-recovery";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inbox action recovery · Sandra CRM" };

export default async function InboxReceiptRecoveryPage() {
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) redirect("/login");
  let identity;
  try {
    identity = await createSupabaseInboxRepository(client as unknown as InboxRpcClient).getContext(AbortSignal.timeout(15_000));
  } catch { identity = null; }
  if (!identity || identity.userId !== data.user.id) return <main><h1>Action recovery unavailable</h1><p>Your current workspace access could not be verified.</p><a href="/messages">Back to Messages</a></main>;
  return <InboxReceiptRecovery identity={identity} />;
}
