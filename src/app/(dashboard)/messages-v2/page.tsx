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
  confirmDoNotContactAction,
  retrySuppressionHoldAction,
  setReplyGenerationAction,
  undoJevAppliedAction,
  findJevUndoAction,
} from "./actions";
import { lunaSuggestionsEnabled } from "@/lib/sms-classification/luna/config";

import { applyLunaSuggestionAction, rejectLunaSuggestionAction } from "./luna-actions";
import { withFreshSeen } from "./hold-seen";
import { loadRunLabels } from "./labels";
import { loadMessagesV2Split, type LooseSupabase } from "./queries";
import { ensureMessagesV2Settings } from "./settings";
import { loadBacklogHoldsAction } from "./backlog-actions";
import { MessagesV2View } from "./messages-v2-view";
import {
  fetchScorecardRows,
  type RpcClient,
  type ScorecardRow,
} from "./scorecard";
import { loadReplayBatchId } from "./replay-batch";
import type { NurtureAutoDripState } from "./nurture-auto-drip-switch";
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

/** Owner-only: the org's nurture auto-drip switch and the drips it can pick. Null hides the control. */
async function loadNurtureAutoDrip(
  supabase: LooseSupabase,
  orgId: string,
): Promise<NurtureAutoDripState | null> {
  try {
    const [cfg, seqs] = await Promise.all([
      supabase
        .from("ai_responder_configs")
        .select("id, nurture_auto_drip, nurture_drip_maybe_later_sequence_id, nurture_drip_check_in_60_sequence_id, nurture_drip_listed_not_selling_sequence_id, nurture_drip_hot_book_appointment_sequence_id")
        .eq("org_id", orgId)
        .maybeSingle(),
      supabase
        .from("sequences")
        .select("id, name")
        .eq("org_id", orgId)
        .eq("active", true)
        .is("archived_at", null)
        .order("name"),
    ]);
    const row = cfg.data as {
      id: string;
      nurture_auto_drip: boolean;
      nurture_drip_maybe_later_sequence_id: string | null;
      nurture_drip_check_in_60_sequence_id: string | null;
      nurture_drip_listed_not_selling_sequence_id: string | null;
      nurture_drip_hot_book_appointment_sequence_id: string | null;
    } | null;
    if (cfg.error || seqs.error || !row) return null;
    return {
      configId: row.id,
      enabled: row.nurture_auto_drip,
      drips: {
        maybeLater: row.nurture_drip_maybe_later_sequence_id,
        checkIn60: row.nurture_drip_check_in_60_sequence_id,
        listedNotSelling: row.nurture_drip_listed_not_selling_sequence_id,
        hotBookAppointment: row.nurture_drip_hot_book_appointment_sequence_id,
      },
      sequences: (seqs.data ?? []) as Array<{ id: string; name: string }>,
    };
  } catch {
    return null;
  }
}

/** The org's active responder config and its "AI drafts" setting (null on any failure: the toggle hides). */
async function loadReplyGeneration(
  supabase: LooseSupabase,
  orgId: string,
): Promise<{ configId: string; replyGeneration: "llm" | "off" } | null> {
  try {
    const { data, error } = await (supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (c: string, v: unknown) => {
            eq: (c: string, v: unknown) => {
              maybeSingle: () => PromiseLike<{
                data: { id: string; reply_generation: string } | null;
                error: unknown;
              }>;
            };
          };
        };
      };
    })
      .from("ai_responder_configs")
      .select("id, reply_generation")
      .eq("org_id", orgId)
      .eq("active", true)
      .maybeSingle();
    if (error || !data) return null;
    if (data.reply_generation !== "llm" && data.reply_generation !== "off") return null;
    return { configId: data.id, replyGeneration: data.reply_generation };
  } catch {
    return null;
  }
}

/** 7-day scorecard for first paint; null lets the client card load/retry itself. */
async function loadScorecard(
  supabase: LooseSupabase,
  orgId: string,
): Promise<ScorecardRow[] | null> {
  try {
    return await fetchScorecardRows(supabase as unknown as RpcClient, orgId, 7);
  } catch {
    return null;
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

  const lunaEnabled = lunaSuggestionsEnabled();
  const supabase = (await createClient()) as unknown as LooseSupabase;
  // First load fixes the New / Backlog cutover at now() (never moved after);
  // it must exist before the hold classification runs.
  await ensureMessagesV2Settings(createAdminClient() as unknown as LooseSupabase, orgId);
  const [loaded, coverage, scorecardRows, replayBatchId, replySetting, nurtureAutoDrip] = await Promise.all([
    loadMessagesV2Split(supabase, orgId, undefined, { includeDraftBody: true, includeLuna: lunaEnabled }),
    loadCoverage(orgId),
    loadScorecard(supabase, orgId),
    isOwner ? loadReplayBatchId(supabase, orgId) : Promise.resolve(null),
    loadReplyGeneration(supabase, orgId),
    isOwner ? loadNurtureAutoDrip(supabase, orgId) : Promise.resolve(null),
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
        replyGeneration={replySetting}
        setReplyGeneration={setReplyGenerationAction}
        undoJevAction={undoJevAppliedAction}
        findJevUndo={findJevUndoAction}
        replayBatchId={replayBatchId}
        nurtureAutoDrip={nurtureAutoDrip}
        coverage={coverage === "unavailable" ? null : coverage}
        coverageUnavailable={coverage === "unavailable"}
        holdsMeta={data.holdsMeta}
        holdsSplit={data.split}
        loadBacklog={loadBacklogHoldsAction}
        runs={data.runs}
        holds={data.holds}
        feedError={data.feedError}
        stepsUnavailable={data.stepsUnavailable}
        badgesError={data.badgesError}
        badges={data.badges}
        scorecardRows={scorecardRows}
        labels={[...labels.entries()]}
        nowMs={data.nowMs}
        lunaEnabled={lunaEnabled}
        actions={{
          send: sendHeldDraftAction,
          editAndSend: editAndSendHeldDraftAction,
          takeOver: takeOverHoldAction,
          assign: assignHoldAction,
          dismiss: dismissHoldAction,
          retrySuppression: retrySuppressionHoldAction,
          confirmDoNotContact: confirmDoNotContactAction,
          listAssignees: listHoldAssigneesAction,
          ...(lunaEnabled
            ? {
                lunaApply: applyLunaSuggestionAction,
                lunaReject: rejectLunaSuggestionAction,
              }
            : {}),
        }}
      />
    </div>
  );
}
