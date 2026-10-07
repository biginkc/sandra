import { notFound } from "next/navigation";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { messagesV2Context } from "./access";
import {
  assignHoldAction,
  dismissHoldAction,
  editAndSendHeldDraftAction,
  listHoldAssigneesAction,
  sendHeldDraftAction,
  takeOverHoldAction,
  retrySuppressionHoldAction,
} from "./actions";
import { withFreshSeen } from "./hold-seen";
import { loadRunLabels } from "./labels";
import { loadMessagesV2Data, type LooseSupabase } from "./queries";
import { MessagesV2View } from "./messages-v2-view";
import { loadReplayBatchId } from "./replay-batch";
import type { PipelineCoverage } from "./types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Messages v2 · Sandra CRM",
};

/**
 * Inbound vs run counts for the last hour, so a silently failing seam shows up
 * in the header. getPipelineCoverage lives in src/lib/pipeline-runs; resolve it
 * defensively so the page still renders if it errors; a failure shows "coverage unavailable".
 */
async function loadCoverage(
  orgId: string,
): Promise<PipelineCoverage | "unavailable"> {
  try {
    const mod = (await import("@/lib/pipeline-runs")) as unknown as {
      getPipelineCoverage?: (
        admin: unknown,
        orgId: string,
        opts: { sinceMinutes: number },
      ) => Promise<PipelineCoverage>;
    };
    if (typeof mod.getPipelineCoverage !== "function") return "unavailable";
    return await mod.getPipelineCoverage(createAdminClient(), orgId, {
      sinceMinutes: 60,
    });
  } catch {
    return "unavailable";
  }
}

/**
 * Live feed of every inbound SMS the pipeline processed (gates, Jev judgment,
 * applied actions, replies, holds), plus the holds rail with its Phase 1
 * actions (Send, Edit, Take over, Assign, Dismiss). Visible to org owners and
 * the Acquisitions group.
 */
export default async function MessagesV2Page() {
  const access = messagesV2Context(await getCallerMembershipsOrThrow());
  if (!access) notFound();
  const { orgId, isOwner } = access;

  const supabase = (await createClient()) as unknown as LooseSupabase;
  const [loaded, coverage, replayBatchId] = await Promise.all([
    loadMessagesV2Data(supabase, orgId, undefined, { includeDraftBody: true }),
    loadCoverage(orgId),
    isOwner ? loadReplayBatchId(supabase, orgId) : Promise.resolve(null),
  ]);
  // The hold queries are windowed; the version each card sends back is read
  // fresh per displayed property so a hold past the window can still be dismissed.
  const data = { ...loaded, holds: await withFreshSeen(supabase, orgId, loaded.holds) };

  // Hold cards are labelled by property id; synthesize label inputs from the
  // hold's run (or just the property for runless fallback cards).
  const holdLabelInputs = data.holds.map((h) => ({
    id: h.id,
    contact_id: h.run?.contact_id ?? null,
    property_id: h.property_id,
    inbound_message_id: h.run?.inbound_message_id ?? "",
  }));
  const labels = await loadRunLabels(supabase, [
    ...data.runs,
    ...holdLabelInputs,
  ]);

  return (
    <div className="p-4 md:p-6">
      <MessagesV2View
        orgId={orgId}
        isOwner={isOwner}
        replayBatchId={replayBatchId}
        coverage={coverage === "unavailable" ? null : coverage}
        coverageUnavailable={coverage === "unavailable"}
        holdsMeta={data.holdsMeta}
        runs={data.runs}
        holds={data.holds}
        feedError={data.feedError}
        stepsUnavailable={data.stepsUnavailable}
        badgesError={data.badgesError}
        badges={data.badges}
        labels={[...labels.entries()]}
        nowMs={data.nowMs}
        actions={{
          send: sendHeldDraftAction,
          editAndSend: editAndSendHeldDraftAction,
          takeOver: takeOverHoldAction,
          assign: assignHoldAction,
          dismiss: dismissHoldAction,
          retrySuppression: retrySuppressionHoldAction,
          listAssignees: listHoldAssigneesAction,
        }}
      />
    </div>
  );
}
