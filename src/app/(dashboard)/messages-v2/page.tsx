import { notFound } from "next/navigation";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { createClient } from "@/lib/supabase/server";

import { messagesV2OrgId } from "./access";
import { loadRunLabels } from "./labels";
import { loadMessagesV2Data, type LooseSupabase } from "./queries";
import { MessagesV2View } from "./messages-v2-view";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Messages v2 · Sandra CRM",
};

/**
 * Phase 0 evidence page: a live, read-only feed of every inbound SMS the
 * pipeline processed (gates, Jev judgment, applied actions, replies, holds).
 * Visible to org owners and the Acquisitions group.
 */
export default async function MessagesV2Page() {
  const orgId = messagesV2OrgId(await getCallerMembershipsOrThrow());
  if (!orgId) notFound();

  const supabase = (await createClient()) as unknown as LooseSupabase;
  const data = await loadMessagesV2Data(supabase, orgId);

  const seen = new Map([...data.runs, ...data.holds].map((r) => [r.id, r]));
  const labels = await loadRunLabels(supabase, [...seen.values()]);

  return (
    <div className="p-4 md:p-6">
      <MessagesV2View
        runs={data.runs}
        holds={data.holds}
        badges={data.badges}
        labels={[...labels.entries()]}
        nowMs={data.nowMs}
      />
    </div>
  );
}
