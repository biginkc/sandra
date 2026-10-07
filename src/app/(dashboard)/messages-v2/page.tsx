import { notFound } from "next/navigation";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { messagesV2Context } from "./access";
import { loadRunLabels } from "./labels";
import { loadMessagesV2Data, type LooseSupabase } from "./queries";
import { MessagesV2View } from "./messages-v2-view";
import type { PipelineCoverage } from "./types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Messages v2 · Sandra CRM",
};

/**
 * Inbound vs run counts for the last hour, so a silently failing seam shows up
 * in the header. getPipelineCoverage lives in src/lib/pipeline-runs; resolve it
 * defensively so the page still renders if it is unavailable or errors.
 */
async function loadCoverage(orgId: string): Promise<PipelineCoverage | null> {
  try {
    const mod = (await import("@/lib/pipeline-runs")) as unknown as {
      getPipelineCoverage?: (
        admin: unknown,
        orgId: string,
        opts: { sinceMinutes: number },
      ) => Promise<PipelineCoverage>;
    };
    if (typeof mod.getPipelineCoverage !== "function") return null;
    return await mod.getPipelineCoverage(createAdminClient(), orgId, { sinceMinutes: 60 });
  } catch {
    return null;
  }
}

/**
 * Phase 0 evidence page: a live, read-only feed of every inbound SMS the
 * pipeline processed (gates, Jev judgment, applied actions, replies, holds).
 * Visible to org owners and the Acquisitions group.
 */
export default async function MessagesV2Page() {
  const access = messagesV2Context(await getCallerMembershipsOrThrow());
  if (!access) notFound();
  const { orgId, isOwner } = access;

  const supabase = (await createClient()) as unknown as LooseSupabase;
  const [data, coverage] = await Promise.all([
    loadMessagesV2Data(supabase, orgId),
    loadCoverage(orgId),
  ]);

  // Hold cards are labelled by property id; synthesize label inputs from the
  // hold's run (or just the property for runless fallback cards).
  const holdLabelInputs = data.holds.map((h) => ({
    id: h.id,
    contact_id: h.run?.contact_id ?? null,
    property_id: h.property_id,
    inbound_message_id: h.run?.inbound_message_id ?? "",
  }));
  const labels = await loadRunLabels(supabase, [...data.runs, ...holdLabelInputs]);

  return (
    <div className="p-4 md:p-6">
      <MessagesV2View
        orgId={orgId}
        isOwner={isOwner}
        coverage={coverage}
        runs={data.runs}
        holds={data.holds}
        badges={data.badges}
        labels={[...labels.entries()]}
        nowMs={data.nowMs}
      />
    </div>
  );
}
