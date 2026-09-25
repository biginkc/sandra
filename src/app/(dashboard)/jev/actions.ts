"use server";

import { revalidatePath } from "next/cache";

import { recordConsentEvent } from "@/lib/messaging/consent";
import { pauseContactEnrollments } from "@/lib/sequences/enrollment";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { createClient } from "@/lib/supabase/server";

import { getCorrectionHistory, getNeedsDecisionQueue, type CorrectionHistoryEntry, type JevQueueItem } from "./queries";

/**
 * Root final-review finding (P1 #3, jev-root-final-review.md,
 * 2026-09-20): the Needs-a-decision list fetched once at page load with
 * no subscription/refetch — a fresh below-threshold decision arriving
 * while the page stayed open was invisible until a manual reload. The
 * client polls this action periodically; it's a thin, cacheable wrapper
 * around the same server-only query the page itself uses at SSR time.
 */
export async function refetchNeedsDecisionQueue(): Promise<{ items: JevQueueItem[]; error: string | null }> {
  return getNeedsDecisionQueue();
}

/**
 * Root final-review P2: exposes the full, immutable, sequential
 * correction history for one review/decision row (queried from
 * lead_events, not merely the single current-value slot the row's own
 * columns can show). classifier_event has no correction history — it's
 * never a valid source here.
 */
export async function fetchCorrectionHistory(
  propertyId: string,
  source: "ai_disposition_review" | "jev_lead_decision",
  id: string,
): Promise<Result<{ entries: CorrectionHistoryEntry[] }>> {
  try {
    const { entries, error } = await getCorrectionHistory(propertyId, source, id);
    if (error) return { ok: false, error: { code: "JEV_HISTORY_FAILED", message: error } };
    return ok({ entries });
  } catch (e) {
    reportError(e, { tags: { surface: "jev_fetch_correction_history" }, extra: { source, id } });
    return errFromUnknown(e, "JEV_HISTORY_FAILED");
  }
}

export type JevQueueSource = "ai_disposition_review" | "jev_lead_decision" | "classifier_event";

const FULL_TAXONOMY = ["new_lead", "wrong_number", "not_interested", "nurture", "opted_out", "dnc"] as const;
type FullOutcome = (typeof FULL_TAXONOMY)[number];

/** wrong_number/not_interested/nurture (both sources) and new_lead (
 *  jev_lead_decision only, which already has its own qualify-guard
 *  branch in SQL) write directly via the narrow correction RPCs.
 *  Everything else — new_lead on an ai_disposition_review row, and
 *  opted_out/dnc on either — goes through the sanctioned TS operation
 *  first (qualifyProperty / setOutreachDispo), then a "record" RPC. See
 *  fn_record_*_correction in
 *  20260921003340_jev_review_taxonomy_and_marking.sql for why
 *  suppression can't be re-implemented purely in SQL here. */
const AI_DISPOSITION_DIRECT_SQL_TARGETS = new Set<FullOutcome>(["wrong_number", "not_interested", "nurture"]);
const LEAD_DECISION_DIRECT_SQL_TARGETS = new Set<FullOutcome>([
  "new_lead",
  "wrong_number",
  "not_interested",
  "nurture",
]);

function isFullOutcome(value: string): value is FullOutcome {
  return (FULL_TAXONOMY as readonly string[]).includes(value);
}

/**
 * Confirms a still-pending proposal as-is — no reviewer-name/evidence
 * form, the authenticated actor is inferred by the RPC from auth.uid().
 * For a row that already applied automatically (auto_accepted, or a
 * jev_lead_decision confirmed with no human involved), use
 * markJevQueueItemReviewed instead — confirming a pending row and
 * marking an auto-applied row as reviewed are different operations:
 * the former performs the disposition write, the latter must never
 * re-apply anything that already happened.
 */
export async function confirmJevQueueItem(
  source: JevQueueSource,
  id: string,
): Promise<Result<{ status: string }>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };

    if (source === "ai_disposition_review") {
      const { data, error } = await supabase.rpc("fn_confirm_ai_disposition_review", {
        p_review_id: id,
      });
      if (error) return { ok: false, error: { code: "JEV_CONFIRM_FAILED", message: error.message } };
      const status = (data as { status?: string } | null)?.status;
      if (!status) return { ok: false, error: { code: "JEV_CONFIRM_FAILED", message: "Unexpected response" } };
      revalidatePath("/jev/needs-decision");
      revalidatePath("/jev/review");
      return ok({ status });
    }

    if (source === "jev_lead_decision") {
      const { data, error } = await supabase.rpc("fn_confirm_jev_lead_decision", {
        p_decision_id: id,
      });
      if (error) {
        const message = error.message.includes("DNC_LOCKED")
          ? "This property is permanently locked and cannot be promoted."
          : error.message;
        return { ok: false, error: { code: "JEV_CONFIRM_FAILED", message } };
      }
      const status = (data as { status?: string } | null)?.status;
      if (!status) return { ok: false, error: { code: "JEV_CONFIRM_FAILED", message: "Unexpected response" } };
      revalidatePath("/jev/needs-decision");
      revalidatePath("/jev/review");
      return ok({ status });
    }

    return { ok: false, error: { code: "VALIDATION", message: "classifier_event rows cannot be confirmed." } };
  } catch (e) {
    reportError(e, { tags: { surface: "jev_confirm_queue_item" }, extra: { source, id } });
    return errFromUnknown(e, "JEV_CONFIRM_FAILED");
  }
}

/**
 * Marks an already-applied decision (auto_accepted, or a system-
 * confirmed jev_lead_decision with no human involved) as reviewed —
 * records that a human looked at it, WITHOUT re-running the disposition
 * write or promotion. Idempotent: marking twice keeps the original
 * reviewer/time.
 */
export async function markJevQueueItemReviewed(
  source: JevQueueSource,
  id: string,
): Promise<Result<{ status: string }>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };

    const rpcName =
      source === "ai_disposition_review"
        ? "fn_mark_ai_disposition_review_reviewed"
        : source === "jev_lead_decision"
          ? "fn_mark_jev_lead_decision_reviewed"
          : null;
    if (!rpcName) {
      return { ok: false, error: { code: "VALIDATION", message: "classifier_event rows have nothing to mark reviewed." } };
    }

    const args = source === "ai_disposition_review" ? { p_review_id: id } : { p_decision_id: id };
    const { data, error } = await supabase.rpc(rpcName, args);
    if (error) return { ok: false, error: { code: "JEV_MARK_REVIEWED_FAILED", message: error.message } };
    const status = (data as { status?: string } | null)?.status;
    if (!status) return { ok: false, error: { code: "JEV_MARK_REVIEWED_FAILED", message: "Unexpected response" } };
    revalidatePath("/jev/review");
    return ok({ status });
  } catch (e) {
    reportError(e, { tags: { surface: "jev_mark_queue_item_reviewed" }, extra: { source, id } });
    return errFromUnknown(e, "JEV_MARK_REVIEWED_FAILED");
  }
}

/**
 * Root final-review finding (P1 #3, jev-root-final-review.md,
 * 2026-09-20): a classifier_event row (Jev classify failure/unclear/
 * bad_number, read directly from sms_classification_runs) had no
 * actionable resolution path — it just sat read-only in Review Jev
 * forever. This "promotes" it into a real, pending jev_lead_decisions
 * row (fn_promote_classifier_event_to_decision,
 * 20260921012632_jev_classifier_event_resolution.sql); from that point
 * on it is an ordinary Needs-a-decision item, resolvable via
 * confirmJevQueueItem/correctJevQueueItem with zero further changes.
 * Idempotent — promoting the same event twice returns the existing
 * decision rather than creating a duplicate.
 */
export async function promoteClassifierEventToDecision(
  classificationRunId: string,
): Promise<Result<{ status: string; decisionId: string }>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };

    const { data, error } = await supabase.rpc("fn_promote_classifier_event_to_decision", {
      p_classification_run_id: classificationRunId,
    });
    if (error) {
      return { ok: false, error: { code: "JEV_PROMOTE_FAILED", message: error.message } };
    }
    const result = data as { status?: string; decisionId?: string } | null;
    if (!result?.status || !result.decisionId) {
      return { ok: false, error: { code: "JEV_PROMOTE_FAILED", message: "Unexpected response" } };
    }
    revalidatePath("/jev/needs-decision");
    revalidatePath("/jev/review");
    return ok({ status: result.status, decisionId: result.decisionId });
  } catch (e) {
    reportError(e, { tags: { surface: "jev_promote_classifier_event" }, extra: { classificationRunId } });
    return errFromUnknown(e, "JEV_PROMOTE_FAILED");
  }
}

const CORRECTION_ERROR_MESSAGES: Record<string, string> = {
  STALE_STATE: "This lead changed since Jev made this decision. Reload and try again.",
  DNC_LOCKED: "This property is permanently locked and cannot be promoted.",
  INVALID_CORRECTION_TARGET: "That outcome cannot be chosen here.",
};

function friendlyCorrectionError(message: string): string {
  for (const [code, friendly] of Object.entries(CORRECTION_ERROR_MESSAGES)) {
    if (message.includes(code)) return friendly;
  }
  return message;
}

/**
 * Lets a human pick the correct outcome directly, across the full
 * taxonomy — no evidence/reviewer form, reason is optional. Works
 * whether the row is still pending or already resolved, and more than
 * once on the same row. wrong_number/not_interested/nurture (and
 * new_lead for a jev_lead_decision row) write directly via a guarded SQL
 * RPC — always atomic, never had a race.
 *
 * new_lead on an ai_disposition_review row, and opted_out/dnc on either
 * source, used to go through a separate "begin" RPC, then the sanctioned
 * TS operation (qualifyProperty/setOutreachDispo) in its OWN request,
 * then a "record" RPC. Root review of an earlier round (02b0ad73,
 * jev-root-correction-race.md, 2026-09-20) found that sequence was NOT
 * atomic: a PostgREST RPC releases its row lock the instant it returns,
 * so a concurrent human write landing between "begin" and the sanctioned
 * op's OWN fresh-read CAS guard could be silently overwritten — the
 * "record" step's after-the-fact check cannot undo a write that already
 * happened. Fixed by folding validate+write+audit into ONE RPC, ONE
 * transaction (fn_apply_and_record_*_correction,
 * 20260921020527_jev_correction_atomic_apply.sql) — the property
 * UPDATE's WHERE clause is now the actual concurrency enforcement,
 * checked by Postgres against the live row at write time, not by this
 * function reading state once and hoping nothing changes before it acts
 * on it. No propertyId parameter — the caller never supplies one; the
 * RPC derives it from the locked review/decision row itself.
 *
 * Secondary, already-best-effort concerns setOutreachDispo used to
 * handle (consent_events history row, sequence pause, page
 * revalidation) run here AFTER the atomic RPC commits — same ordering
 * setOutreachDispo itself already used for these same steps. Never
 * unsuppresses on a positive correction — the atomic RPC only ever ADDS
 * suppression (contacts.sms_opted_out), never clears it.
 */
export async function correctJevQueueItem(
  source: JevQueueSource,
  id: string,
  correctedOutcome: string,
  reason: string | null,
): Promise<Result<{ status: string; resolvedOutcome: string }>> {
  try {
    if (!isFullOutcome(correctedOutcome)) {
      return { ok: false, error: { code: "VALIDATION", message: `Unsupported outcome: ${correctedOutcome}` } };
    }
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };

    if (source === "classifier_event") {
      return { ok: false, error: { code: "VALIDATION", message: "classifier_event rows cannot be corrected — no decision was made." } };
    }

    const directTargets = source === "ai_disposition_review" ? AI_DISPOSITION_DIRECT_SQL_TARGETS : LEAD_DECISION_DIRECT_SQL_TARGETS;

    if (directTargets.has(correctedOutcome)) {
      const rpcName = source === "ai_disposition_review" ? "fn_correct_ai_disposition_review" : "fn_correct_jev_lead_decision";
      const args =
        source === "ai_disposition_review"
          ? { p_review_id: id, p_corrected_disposition: correctedOutcome, p_reason: reason ?? "" }
          : { p_decision_id: id, p_corrected_outcome: correctedOutcome, p_reason: reason ?? "" };
      const { data, error } = await supabase.rpc(rpcName, args);
      if (error) {
        return { ok: false, error: { code: "JEV_CORRECTION_FAILED", message: friendlyCorrectionError(error.message) } };
      }
      const result = data as { status?: string; correctedDisposition?: string; resolvedOutcome?: string } | null;
      const resolvedOutcome = result?.correctedDisposition ?? result?.resolvedOutcome;
      if (!result?.status || !resolvedOutcome) {
        return { ok: false, error: { code: "JEV_CORRECTION_FAILED", message: "Unexpected response" } };
      }
      revalidatePath("/jev/needs-decision");
      revalidatePath("/jev/review");
      return ok({ status: result.status, resolvedOutcome });
    }

    // new_lead (ai_disposition_review only) / opted_out / dnc: one atomic
    // validate+write+audit RPC — no separate sanctioned-op round trip.
    const rpcName =
      source === "ai_disposition_review"
        ? "fn_apply_and_record_ai_disposition_review_correction"
        : "fn_apply_and_record_jev_lead_decision_correction";
    const args =
      source === "ai_disposition_review"
        ? { p_review_id: id, p_corrected_disposition: correctedOutcome, p_reason: reason ?? "" }
        : { p_decision_id: id, p_corrected_outcome: correctedOutcome, p_reason: reason ?? "" };
    const { data, error } = await supabase.rpc(rpcName, args);
    if (error) {
      return { ok: false, error: { code: "JEV_CORRECTION_FAILED", message: friendlyCorrectionError(error.message) } };
    }
    const result = data as
      | { status?: string; correctedDisposition?: string; resolvedOutcome?: string; propertyId?: string; homeownerContactId?: string | null }
      | null;
    const resolvedOutcome = result?.correctedDisposition ?? result?.resolvedOutcome;
    if (!result?.status || !resolvedOutcome) {
      return { ok: false, error: { code: "JEV_CORRECTION_FAILED", message: "Unexpected response" } };
    }

    // Best-effort secondary bookkeeping — the disposition/promotion write
    // and its audit row already committed atomically above; nothing below
    // can undo or falsify that.
    if (result.status === "corrected" && (correctedOutcome === "opted_out" || correctedOutcome === "dnc") && result.propertyId) {
      await applyCorrectionSuppressionFollowUps({
        propertyId: result.propertyId,
        homeownerContactId: result.homeownerContactId ?? null,
        dispo: correctedOutcome,
        actorId: user.id,
      });
    }

    revalidatePath("/jev/needs-decision");
    revalidatePath("/jev/review");
    return ok({ status: result.status, resolvedOutcome });
  } catch (e) {
    reportError(e, { tags: { surface: "jev_correct_queue_item" }, extra: { source, id, correctedOutcome } });
    return errFromUnknown(e, "JEV_CORRECTION_FAILED");
  }
}

/**
 * Same best-effort secondary steps `setOutreachDispo` already performs
 * after its own core write commits: a `consent_events` history row and
 * pausing sequences for the contact. The core suppression enforcement
 * (properties.outreach_dispo, checked by `shouldSuppressAutomatedSend`,
 * and contacts.sms_opted_out) already happened atomically inside
 * fn_apply_and_record_*_correction — nothing here is safety-critical.
 */
async function applyCorrectionSuppressionFollowUps(args: {
  propertyId: string;
  homeownerContactId: string | null;
  dispo: "opted_out" | "dnc";
  actorId: string;
}): Promise<void> {
  if (!args.homeownerContactId) return;
  const supabase = await createClient();
  try {
    const consentOutcome = await recordConsentEvent(supabase, {
      contactId: args.homeownerContactId,
      channel: "sms",
      eventType: "opt_out",
      source: "jev_correction",
      sourceDetail: { propertyId: args.propertyId, dispo: args.dispo },
    });
    if (consentOutcome.inserted) {
      await recordLeadEvent({
        propertyId: args.propertyId,
        eventType: LEAD_EVENT_TYPES.OPTED_OUT,
        actorType: "user",
        actorId: args.actorId,
        payload: { channel: "sms", trigger: "jev_correction" },
        sourceType: "consent_events.opt_out",
        sourceId: consentOutcome.id,
      });
    }
  } catch (error) {
    reportError(error, {
      tags: { surface: "jev_correction_consent_after_commit" },
      extra: { propertyId: args.propertyId, contactId: args.homeownerContactId, dispo: args.dispo },
    });
  }
  try {
    await pauseContactEnrollments(supabase, {
      contactId: args.homeownerContactId,
      reason: "consent_revoked",
      permanent: true,
      actor: { actorType: "user", actorId: args.actorId },
    });
  } catch (error) {
    reportError(error, {
      tags: { surface: "jev_correction_sequence_pause_after_commit" },
      extra: { propertyId: args.propertyId, contactId: args.homeownerContactId, dispo: args.dispo },
    });
  }
}
