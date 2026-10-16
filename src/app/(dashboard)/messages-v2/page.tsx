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
import { loadRunLabels } from "./labels";
import { loadHoldsByIds, loadMessagesV2Page } from "./holds-by-activity";
import { fetchAllKeyset } from "./paged";
import type { LooseSupabase } from "./queries";
import { ensureMessagesV2Settings } from "./settings";
import { loadOlderHoldsAction, revalidateHoldsAction } from "./backlog-actions";
import { MessagesV2View } from "./messages-v2-view";
import {
  fetchScorecardRows,
  type RpcClient,
  type ScorecardRow,
} from "./scorecard";
import { loadReplayBatchId } from "./replay-batch";
import { loadTapeDayAction } from "./tape-actions";
import { loadRunThreads } from "./tape-data";
import type { NurtureAutoDripState } from "./nurture-auto-drip-switch";
import type { WaitingSnapshot } from "./hold-list";
import type { OpenHold, PipelineCoverage, RunWithSteps } from "./types";

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
      fetchAllKeyset<{ id: string; name: string }>(() =>
        supabase.from("sequences").select("id, name").eq("org_id", orgId).eq("active", true).is("archived_at", null),
      ),
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
      sequences: [...seqs.rows].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)),
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
/** ?deadLetter=<id>: resolve the failed reply's lead (org-scoped read) so its hold card can be selected. */
async function resolveFocusDeadLetter(
  supabase: LooseSupabase,
  orgId: string,
  raw: string | string[] | undefined,
): Promise<{ deadLetterId: string; propertyId: string | null } | null> {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  try {
    const { data, error } = await (supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (c: string, v: string) => {
            eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: { property_id: string | null } | null; error: unknown }> };
          };
        };
      };
    })
      .from("ai_reply_dead_letters")
      .select("property_id")
      .eq("id", id)
      .eq("org_id", orgId)
      .maybeSingle();
    return { deadLetterId: id, propertyId: error || !data ? null : data.property_id };
  } catch {
    return { deadLetterId: id, propertyId: null };
  }
}

export default async function MessagesV2Page({
  searchParams,
}: {
  searchParams: Promise<{ deadLetter?: string | string[] }>;
}) {
  const access = messagesV2Context(await getCallerMembershipsOrThrow());
  if (!access) notFound();
  const { orgId, isOwner } = access;

  const supabase = (await createClient()) as unknown as LooseSupabase;
  const focusDeadLetter = await resolveFocusDeadLetter(supabase, orgId, (await searchParams)?.deadLetter);
  // First load fixes the New / Backlog cutover at now() (never moved after);
  // it must exist before the hold classification runs.
  await ensureMessagesV2Settings(createAdminClient() as unknown as LooseSupabase, orgId);
  const [loaded, coverage, scorecardRows, replayBatchId, replySetting, nurtureAutoDrip] = await Promise.all([
    loadMessagesV2Page(supabase, orgId),
    loadCoverage(orgId),
    loadScorecard(supabase, orgId),
    isOwner ? loadReplayBatchId(supabase, orgId) : Promise.resolve(null),
    loadReplyGeneration(supabase, orgId),
    isOwner ? loadNurtureAutoDrip(supabase, orgId) : Promise.resolve(null),
  ]);
  const data = loaded;
  // A failed reply opened from My Leads whose hold is beyond the first page: load it by id and pin it on top.
  const focusPid = focusDeadLetter?.propertyId ?? null;
  let focusHold: OpenHold<RunWithSteps> | null | undefined;
  let focusHoldErrors: string[] = [];
  let focusSnapshot: WaitingSnapshot | undefined;
  if (focusPid && !loaded.error && !data.holds.some((h) => h.property_id === focusPid)) {
    const byId = await loadHoldsByIds(supabase, orgId, [focusPid]);
    focusHold = byId ? (byId.holds.find((h) => h.property_id === focusPid) ?? null) : undefined;
    focusHoldErrors = byId?.contextErrors ?? [];
    focusSnapshot = byId?.snapshot;
  }

  // Hold cards are labelled by property id; synthesize label inputs from the
  // hold's run (or just the property for runless fallback cards).
  const holdLabelInputs = [...data.holds, ...(focusHold ? [focusHold] : [])].map((h) => ({
    id: h.id,
    contact_id: h.run?.contact_id ?? null,
    property_id: h.property_id,
    inbound_message_id: h.run?.inbound_message_id ?? "",
  }));
  const [labels, thread] = await Promise.all([
    loadRunLabels(supabase, [...data.runs, ...holdLabelInputs]),
    loadRunThreads(supabase, orgId, data.runs),
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
        holdsSnapshot={loaded.snapshot}
        holdsMissing={loaded.missing}
        revalidateHolds={revalidateHoldsAction}
        holdsError={loaded.error}
        holdsUnverified={loaded.unverified}
        flagReasons={loaded.flagReasons}
        loadOlderHolds={loadOlderHoldsAction}
        runs={data.runs}
        holds={data.holds}
        feedError={data.feedError}
        stepsUnavailable={data.stepsUnavailable}
        badgesError={data.badgesError}
        badges={data.badges}
        scorecardRows={scorecardRows}
        labels={[...labels.entries()]}
        threads={[...thread.threads.entries()]}
        threadFailedRunIds={thread.failedRunIds}
        loadTapeDay={loadTapeDayAction}
        nowMs={data.nowMs}
        focusDeadLetter={focusDeadLetter}
        focusHold={focusHold}
        focusHoldErrors={focusHoldErrors}
        focusSnapshot={focusSnapshot}
        actions={{
          send: sendHeldDraftAction,
          editAndSend: editAndSendHeldDraftAction,
          takeOver: takeOverHoldAction,
          assign: assignHoldAction,
          dismiss: dismissHoldAction,
          retrySuppression: retrySuppressionHoldAction,
          confirmDoNotContact: confirmDoNotContactAction,
          listAssignees: listHoldAssigneesAction,
        }}
      />
    </div>
  );
}
