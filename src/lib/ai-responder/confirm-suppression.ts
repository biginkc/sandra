import { normalizePhone } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { suppressionReviewIdsFromReason } from "@/lib/ai-responder/format-reason";
import { applyPhoneLevelOptOut } from "@/lib/messaging/opt-out-phone";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export const SUPPRESSION_INCOMPLETE_WARNING =
  "Confirmed, but suppression incomplete — retry.";

/** Bare prefix; new holds carry the failed review id: `suppression_incomplete:<reviewId>`. */
export const SUPPRESSION_INCOMPLETE_REASON = "suppression_incomplete";
export const SUPPRESSION_INCOMPLETE_EVENT = "suppression_incomplete";
export const SUPPRESSION_RETRIED_OK_EVENT = "suppression_retried_ok";
const SUPPRESSION_FAILED_SOURCE = "ai_disposition_reviews";
const SUPPRESSION_RETRIED_SOURCE = "ai_disposition_reviews.suppression_retried";

export { suppressionReviewIdsFromReason };

/** Max failed ids one hold reason carries (oldest kept). */
export const MAX_SUPPRESSION_REASON_IDS = 10;

/** Builds `suppression_incomplete:<idA>,<idB>`: de-duplicated, capped at 10 (oldest kept). */
export function suppressionIncompleteReason(reviewIds: string | string[]): string {
  const ids = [...new Set(Array.isArray(reviewIds) ? reviewIds : [reviewIds])].slice(
    0,
    MAX_SUPPRESSION_REASON_IDS,
  );
  return `${SUPPRESSION_INCOMPLETE_REASON}:${ids.join(",")}`;
}

export function isSuppressionIncompleteReason(
  reason: string | null | undefined,
): boolean {
  return (
    !!reason &&
    (reason === SUPPRESSION_INCOMPLETE_REASON ||
      reason.startsWith(`${SUPPRESSION_INCOMPLETE_REASON}:`))
  );
}

export function suppressionReviewIdFromReason(
  reason: string | null | undefined,
): string | null {
  return suppressionReviewIdsFromReason(reason)[0] ?? null;
}

type LedgerClient = { from: (table: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Failed review ids still waiting on suppression for a property: the id in the
 * hold reason plus every `suppression_incomplete` lead event with no
 * `suppression_retried_ok` event at all (an id is resolved whenever a
 * retried_ok row exists, regardless of created_at order). Throws on read errors so a
 * caller never mistakes an unreadable ledger for "nothing outstanding".
 */
export async function listOutstandingSuppressionReviews(
  supabase: LedgerClient,
  propertyId: string,
): Promise<{ reviewIds: string[]; reason: string | null }> {
  const { data: property, error: propError } = await supabase
    .from("properties")
    .select("last_ai_escalation_reason")
    .eq("id", propertyId)
    .maybeSingle();
  if (propError) throw new Error(propError.message);
  const reason: string | null = property?.last_ai_escalation_reason ?? null;
  const { data: events, error: eventsError } = await supabase
    .from("lead_events")
    .select("event_type, source_id, created_at")
    .eq("property_id", propertyId)
    .in("event_type", [SUPPRESSION_INCOMPLETE_EVENT, SUPPRESSION_RETRIED_OK_EVENT]);
  if (eventsError) throw new Error(eventsError.message);

  const failedAt = new Map<string, string>();
  const okAt = new Map<string, string>();
  for (const e of (events ?? []) as Array<{
    event_type: string;
    source_id: string | null;
    created_at: string;
  }>) {
    if (!e.source_id) continue;
    const bucket = e.event_type === SUPPRESSION_RETRIED_OK_EVENT ? okAt : failedAt;
    const prior = bucket.get(e.source_id);
    if (!prior || e.created_at > prior) bucket.set(e.source_id, e.created_at);
  }
  const ids: string[] = [];
  for (const reasonId of suppressionReviewIdsFromReason(reason)) {
    if (!okAt.has(reasonId) && !ids.includes(reasonId)) ids.push(reasonId);
  }
  for (const id of failedAt.keys()) {
    if (okAt.has(id)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return { reviewIds: ids, reason };
}

/** Marks one failed review as successfully suppressed. Never throws. */
export async function recordSuppressionRetriedOk(input: {
  propertyId: string;
  reviewId: string;
  /** Null for system actors (the sweeper when the review has no reviewer). */
  actorId: string | null;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: property, error: readError } = await admin
      .from("properties")
      .select("org_id")
      .eq("id", input.propertyId)
      .maybeSingle();
    if (readError || !property) throw new Error(readError?.message ?? "property not found");
    const { error } = await admin.from("lead_events").insert({
      org_id: property.org_id,
      property_id: input.propertyId,
      actor_type: input.actorId ? "user" : "system",
      actor_id: input.actorId,
      event_type: SUPPRESSION_RETRIED_OK_EVENT,
      payload: { reviewId: input.reviewId },
      source_type: SUPPRESSION_RETRIED_SOURCE,
      source_id: input.reviewId,
    });
    if (error && (error as { code?: string }).code !== "23505") {
      throw new Error(error.message);
    }
  } catch (e) {
    reportError(e, {
      tags: { surface: "suppression_retried_ok_event" },
      extra: { reviewId: input.reviewId, propertyId: input.propertyId },
    });
  }
}

export type ConfirmedSuppressionResult =
  | { ok: true }
  | { ok: false; warning: string };

/**
 * fn_confirm_ai_disposition_review only flips contacts.sms_opted_out. When a
 * human confirms a held opted_out/dnc review this runs the same phone-level
 * suppression the automated responder path uses (consent event, drip pause,
 * phone suppression), with the same idempotency-key shape so retries and
 * replays collapse. Never throws.
 */
export async function applyConfirmedSuppression(input: {
  reviewId: string;
  contactId: string | null;
  phone: string | null;
  propertyId: string;
  orgId: string;
  disposition: string;
  actorId: string | null;
  aiReason?: string | null;
  /** Sweeper: skip the per-failure reportError; the caller throttles reports. */
  quiet?: boolean;
  /**
   * A wrong_number the model scoped to every property (wrong_scope = "all"):
   * suppresses the phone on the dnc surface once a human confirmed the review.
   */
  phoneWide?: boolean;
}): Promise<ConfirmedSuppressionResult> {
  const phoneWideWrongNumber = input.disposition === "wrong_number" && input.phoneWide === true;
  if (input.disposition !== "opted_out" && input.disposition !== "dnc" && !phoneWideWrongNumber) {
    return { ok: true };
  }
  const isDnc = input.disposition === "dnc" || phoneWideWrongNumber;
  try {
    if (!input.phone) throw new Error("applyConfirmedSuppression: no phone on contact");
    // recordSmsPhoneSuppression returns silently for an un-normalizable phone,
    // which would otherwise look like proof of suppression and discharge the
    // obligation. Fail instead so the hold stays up.
    if (!normalizePhone(input.phone)) {
      throw new Error("applyConfirmedSuppression: phone cannot be normalized");
    }
    const reason = input.aiReason || input.reviewId;
    await applyPhoneLevelOptOut(createAdminClient(), {
      contactId: input.contactId,
      fromPhone: input.phone,
      orgId: input.orgId,
      source: phoneWideWrongNumber
        ? "ai_responder_wrong_number"
        : isDnc
          ? "ai_responder_threat"
          : "ai_responder",
      sourceDetail: {
        propertyId: input.propertyId,
        reason,
        reviewId: input.reviewId,
        confirmedBy: input.actorId,
      } as Json,
      occurredAt: new Date(),
      providerId: "ai_responder",
      surface: isDnc ? "dnc" : "stop",
      idempotencyKey: phoneWideWrongNumber
        ? `ai-responder-wrong-number:${input.propertyId}:${input.contactId}`
        : isDnc
        ? `ai-responder-dnc:${input.propertyId}:${input.contactId}:${reason}`
        : `ai-responder:${input.propertyId}:${input.contactId}:${reason}`,
    });
    await recordLeadEvent({
      propertyId: input.propertyId,
      eventType: LEAD_EVENT_TYPES.OPTED_OUT,
      ...(input.actorId
        ? { actorType: "user" as const, actorId: input.actorId }
        : { actorType: "system" as const }),
      payload: {
        channel: "sms",
        trigger: "human_confirmed_ai_review",
        disposition: input.disposition,
        reviewId: input.reviewId,
      },
      sourceType: "ai_disposition_reviews.confirmed_suppression",
      sourceId: input.reviewId,
    });
    return { ok: true };
  } catch (error) {
    if (!input.quiet) {
      reportError(error, {
        tags: { surface: "confirm_ai_disposition_suppression" },
        extra: { reviewId: input.reviewId, disposition: input.disposition },
      });
    }
    await raiseSuppressionIncompleteHold(input.propertyId, input.reviewId);
    return { ok: false, warning: SUPPRESSION_INCOMPLETE_WARNING };
  }
}

/**
 * fn_confirm_ai_disposition_review clears needs_human_attention, so a failed
 * suppression would otherwise vanish from every queue. Re-raise the hold so
 * the lead stays visible until a human retries. Never throws.
 */
async function raiseSuppressionIncompleteHold(
  propertyId: string,
  reviewId: string,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const orgIdBox: { orgId?: string } = {};
    // Idempotent via the unique index: a duplicate row counts as recorded.
    const writeLedger = async (id: string): Promise<boolean> => {
      try {
        if (!orgIdBox.orgId) throw new Error("property not found");
        const { error: ledgerError } = await admin.from("lead_events").insert({
          org_id: orgIdBox.orgId,
          property_id: propertyId,
          actor_type: "system",
          event_type: SUPPRESSION_INCOMPLETE_EVENT,
          payload: { reviewId: id },
          source_type: SUPPRESSION_FAILED_SOURCE,
          source_id: id,
        });
        if (ledgerError && (ledgerError as { code?: string }).code !== "23505") {
          throw new Error(ledgerError.message);
        }
        return true;
      } catch (ledgerErr) {
        reportError(ledgerErr, {
          tags: { surface: "confirm_ai_disposition_suppression_ledger" },
          extra: { reviewId: id, propertyId },
        });
        return false;
      }
    };
    const readPointer = async (): Promise<string | null> => {
      const { data: current, error: readError } = await admin
        .from("properties")
        .select("org_id, last_ai_escalation_reason")
        .eq("id", propertyId)
        .maybeSingle();
      if (readError) throw new Error(readError.message);
      orgIdBox.orgId = current?.org_id;
      return current?.last_ai_escalation_reason ?? null;
    };

    const existing = await readPointer();
    // Record the failed review id in the ledger BEFORE touching the hold, so
    // it survives a preserved timeout reason or a concurrent overwrite.
    await writeLedger(reviewId);

    // Best-effort backfill: the existing pointer may be the ONLY record of
    // earlier failures whose ledger writes failed. Outcomes are irrelevant to
    // the merge: the database decides, under the property row lock, which ids
    // have a live ledger row (backed, pruned) and which exist only on the
    // pointer (kept; cap applies to those alone). The caller just reports every
    // id it knows about.
    const knownIds: string[] = [reviewId];
    for (const id of suppressionReviewIdsFromReason(existing)) {
      if (id === reviewId) continue;
      await writeLedger(id);
      knownIds.push(id);
    }

    // One atomic call. The hint is used by the database only when nothing else
    // would be left; a timeout reason is kept (hold only) unless an id with no
    // ledger row exists.
    const { data: merged, error } = await admin.rpc(
      "fn_merge_suppression_incomplete_pointer",
      {
        p_property_id: propertyId,
        p_ids: [...new Set(knownIds)],
        p_hint_id: reviewId,
      },
    );
    if (error) throw new Error(error.message);
    const row = Array.isArray(merged) ? merged[0] : merged;
    const dropped: string[] = row?.dropped_ids ?? [];
    if (dropped.length > 0) {
      reportError(new Error("suppression_incomplete reason id cap reached"), {
        tags: { surface: "confirm_ai_disposition_suppression_id_cap" },
        extra: { propertyId, dropped },
      });
    }
  } catch (holdError) {
    reportError(holdError, {
      tags: { surface: "confirm_ai_disposition_suppression_hold" },
      extra: { reviewId, propertyId },
    });
  }
}

/**
 * Discharges the durable suppression obligation that fn_confirm_ai_disposition_review
 * records in the same transaction as the confirm. Call ONLY after phone-level
 * suppression succeeded. If a `suppression_incomplete` ledger row exists for the
 * review it writes `suppression_retried_ok` (idempotent on the unique identity),
 * then lets the database decide, under the property lock, whether the hold clears.
 * No ledger row (a confirm that never needed phone suppression) writes nothing.
 * Never throws.
 */
export async function dischargeSuppressionObligation(input: {
  propertyId: string;
  reviewId: string;
  actorId: string | null;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: ledgerRow, error: ledgerError } = await admin
      .from("lead_events")
      .select("id")
      .eq("property_id", input.propertyId)
      .eq("event_type", SUPPRESSION_INCOMPLETE_EVENT)
      .eq("source_type", SUPPRESSION_FAILED_SOURCE)
      .eq("source_id", input.reviewId)
      .maybeSingle();
    if (ledgerError) throw new Error(ledgerError.message);
    if (!ledgerRow) return;
    await recordSuppressionRetriedOk(input);
    const { error: clearError } = await admin.rpc("fn_clear_suppression_hold_if_resolved", {
      p_property_id: input.propertyId,
    });
    if (clearError) throw new Error(clearError.message);
  } catch (e) {
    reportError(e, {
      tags: { surface: "suppression_obligation_discharge" },
      extra: { reviewId: input.reviewId, propertyId: input.propertyId },
    });
  }
}

type ReviewLookupClient = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/**
 * Loads the confirmed review + homeowner phone, then applies suppression.
 * Only call after fn_confirm_ai_disposition_review returned "confirmed".
 */
export async function applySuppressionForConfirmedReview(
  supabase: ReviewLookupClient,
  reviewId: string,
  actorId: string | null,
  options: { discharge?: boolean; quiet?: boolean } = {},
): Promise<ConfirmedSuppressionResult> {
  let heldPropertyId: string | null = null;
  try {
    const { data: review, error } = await supabase
      .from("ai_disposition_reviews")
      .select("property_id, org_id, disposition, ai_reason, source_inbound_message_id, wrong_scope")
      .eq("id", reviewId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!review) throw new Error("review not found");
    heldPropertyId = review.property_id;
    const phoneWide = review.disposition === "wrong_number" && review.wrong_scope === "all";
    if (review.disposition !== "opted_out" && review.disposition !== "dnc" && !phoneWide) {
      return { ok: true };
    }
    const { data: property, error: propError } = await supabase
      .from("properties")
      .select("homeowner_contact_id")
      .eq("id", review.property_id)
      .eq("org_id", review.org_id)
      .maybeSingle();
    if (propError) throw new Error(propError.message);
    const contactId: string | null = property?.homeowner_contact_id ?? null;
    // The automated path suppresses the number that actually texted
    // (inboundFromPhone); mirror it, falling back to the contact phone only
    // when the source message is gone.
    let phone: string | null = null;
    if (review.source_inbound_message_id) {
      const { data: message, error: messageError } = await supabase
        .from("messages")
        .select("from_address")
        .eq("id", review.source_inbound_message_id)
        .eq("org_id", review.org_id)
        .maybeSingle();
      if (messageError) throw new Error(messageError.message);
      phone = message?.from_address ?? null;
    }
    if (!phone && contactId) {
      const { data: contact, error: contactError } = await supabase
        .from("contacts")
        .select("phone_1")
        .eq("id", contactId)
        .eq("org_id", review.org_id)
        .maybeSingle();
      if (contactError) throw new Error(contactError.message);
      phone = contact?.phone_1 ?? null;
    }
    const result = await applyConfirmedSuppression({
      reviewId,
      contactId,
      phone,
      propertyId: review.property_id,
      orgId: review.org_id,
      disposition: review.disposition,
      actorId,
      aiReason: review.ai_reason,
      quiet: options.quiet,
      phoneWide,
    });
    // First-attempt callers and the sweeper discharge the obligation the confirm
    // RPC recorded; the manual retry action does its own record + clear.
    if (result.ok && options.discharge) {
      await dischargeSuppressionObligation({ propertyId: review.property_id, reviewId, actorId });
    }
    return result;
  } catch (error) {
    if (!options.quiet) {
      reportError(error, {
        tags: { surface: "confirm_ai_disposition_suppression_lookup" },
        extra: { reviewId },
      });
    }
    if (heldPropertyId) await raiseSuppressionIncompleteHold(heldPropertyId, reviewId);
    return { ok: false, warning: SUPPRESSION_INCOMPLETE_WARNING };
  }
}

/**
 * Sweeper step: retry phone-level suppression for confirmed opted_out/dnc reviews
 * whose durable obligation (ledger row from the confirm RPC or a failed attempt)
 * is older than `olderThanSeconds`, not yet discharged and past its DB-side
 * backoff (2m, 10m, 1h, 6h, then daily). Then re-run the hold-clear decision for
 * holds whose ids are all resolved (a clear that failed after the ok write).
 * Bounded batches. Safe to run concurrently with itself and with a human Retry:
 * phone suppression is idempotent, the retried_ok insert collapses on its
 * unique identity, and every clear decision is made by the database under the
 * property lock. Writes as the system actor, never the original reviewer.
 * Failures are counted in the database; reportError fires at most once per
 * review per day after 3 failed attempts. Never throws.
 */
export async function retryOutstandingSuppressionObligations(
  supabase: ReviewLookupClient & { rpc: (fn: string, args?: Record<string, unknown>) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  options: { olderThanSeconds?: number; limit?: number } = {},
): Promise<{ attempted: number; succeeded: number; failed: number; holdsCleared: number }> {
  const result = { attempted: 0, succeeded: 0, failed: 0, holdsCleared: 0 };
  try {
    const { data, error } = await supabase.rpc("fn_list_outstanding_suppression_obligations", {
      p_older_than_seconds: options.olderThanSeconds ?? 120,
      p_limit: options.limit ?? 25,
    });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{
      review_id: string;
      property_id: string;
      org_id: string;
    }>;
    for (const row of rows) {
      result.attempted += 1;
      const outcome = await applySuppressionForConfirmedReview(supabase, row.review_id, null, {
        discharge: true,
        quiet: true,
      });
      if (outcome.ok) {
        result.succeeded += 1;
        continue;
      }
      result.failed += 1;
      await recordSweeperFailure(supabase, row);
    }
  } catch (e) {
    reportError(e, { tags: { surface: "suppression_obligation_sweep" } });
  }
  try {
    const { data, error } = await supabase.rpc("fn_list_resolvable_suppression_holds", {
      p_limit: options.limit ?? 25,
    });
    if (error) throw new Error(error.message);
    // One aggregated report per run so a property whose clear keeps failing
    // cannot page every sweep once per property.
    let clearFailures = 0;
    let firstClear: { propertyId: string; message: string } | null = null;
    for (const row of (data ?? []) as Array<{ property_id: string }>) {
      const { data: cleared, error: clearError } = await supabase.rpc(
        "fn_clear_suppression_hold_if_resolved",
        { p_property_id: row.property_id },
      );
      if (clearError) {
        clearFailures += 1;
        firstClear ??= { propertyId: row.property_id, message: clearError.message };
        continue;
      }
      const r = Array.isArray(cleared) ? cleared[0] : cleared;
      if (r?.cleared) result.holdsCleared += 1;
    }
    if (clearFailures > 0 && firstClear) {
      reportError(new Error(firstClear.message), {
        tags: { surface: "suppression_hold_resolved_clear" },
        extra: { failedCount: clearFailures, firstPropertyId: firstClear.propertyId },
      });
    }
  } catch (e) {
    reportError(e, { tags: { surface: "suppression_hold_resolved_sweep" } });
  }
  return result;
}

async function recordSweeperFailure(
  supabase: { rpc: (fn: string, args?: Record<string, unknown>) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  row: { review_id: string; property_id: string; org_id: string },
): Promise<void> {
  try {
    const { data, error } = await supabase.rpc("fn_record_suppression_attempt_failure", {
      p_review_id: row.review_id,
      p_property_id: row.property_id,
      p_org_id: row.org_id,
    });
    if (error) throw new Error(error.message);
    const r = Array.isArray(data) ? data[0] : data;
    if (r?.should_report) {
      reportError(new Error("suppression obligation keeps failing"), {
        tags: { surface: "suppression_obligation_permanent_failure" },
        extra: { reviewId: row.review_id, propertyId: row.property_id, attempts: r.attempt_count },
      });
    }
  } catch (e) {
    reportError(e, {
      tags: { surface: "suppression_obligation_attempt_record" },
      extra: { reviewId: row.review_id },
    });
  }
}
