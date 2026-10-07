import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
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

export function suppressionIncompleteReason(reviewId: string): string {
  return `${SUPPRESSION_INCOMPLETE_REASON}:${reviewId}`;
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
  if (!reason || !reason.startsWith(`${SUPPRESSION_INCOMPLETE_REASON}:`)) return null;
  return reason.slice(SUPPRESSION_INCOMPLETE_REASON.length + 1) || null;
}

type LedgerClient = { from: (table: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Failed review ids still waiting on suppression for a property: the id in the
 * hold reason plus every `suppression_incomplete` lead event with no
 * `suppression_retried_ok` event at or after it. Throws on read errors so a
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
  const reasonId = suppressionReviewIdFromReason(reason);
  const reasonResolved =
    reasonId !== null && okAt.has(reasonId) && (okAt.get(reasonId) as string) >= (failedAt.get(reasonId) ?? "");
  if (reasonId && !reasonResolved) ids.push(reasonId);
  for (const [id, at] of failedAt) {
    const ok = okAt.get(id);
    if (ok && ok >= at) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return { reviewIds: ids, reason };
}

/** Marks one failed review as successfully suppressed. Never throws. */
export async function recordSuppressionRetriedOk(input: {
  propertyId: string;
  reviewId: string;
  actorId: string;
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
      actor_type: "user",
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
  actorId: string;
  aiReason?: string | null;
}): Promise<ConfirmedSuppressionResult> {
  if (input.disposition !== "opted_out" && input.disposition !== "dnc") {
    return { ok: true };
  }
  const isDnc = input.disposition === "dnc";
  try {
    if (!input.phone) throw new Error("applyConfirmedSuppression: no phone on contact");
    const reason = input.aiReason || input.reviewId;
    await applyPhoneLevelOptOut(createAdminClient(), {
      contactId: input.contactId,
      fromPhone: input.phone,
      orgId: input.orgId,
      source: isDnc ? "ai_responder_threat" : "ai_responder",
      sourceDetail: {
        propertyId: input.propertyId,
        reason,
        reviewId: input.reviewId,
        confirmedBy: input.actorId,
      } as Json,
      occurredAt: new Date(),
      providerId: "ai_responder",
      surface: isDnc ? "dnc" : "stop",
      idempotencyKey: isDnc
        ? `ai-responder-dnc:${input.propertyId}:${input.contactId}:${reason}`
        : `ai-responder:${input.propertyId}:${input.contactId}:${reason}`,
    });
    await recordLeadEvent({
      propertyId: input.propertyId,
      eventType: LEAD_EVENT_TYPES.OPTED_OUT,
      actorType: "user",
      actorId: input.actorId,
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
    reportError(error, {
      tags: { surface: "confirm_ai_disposition_suppression" },
      extra: { reviewId: input.reviewId, disposition: input.disposition },
    });
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
    const now = new Date().toISOString();
    const { data: current, error: readError } = await admin
      .from("properties")
      .select("org_id, last_ai_escalation_reason")
      .eq("id", propertyId)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    const existing: string | null = current?.last_ai_escalation_reason ?? null;
    const orgId: string | undefined = current?.org_id;
    // Idempotent via the unique index: a duplicate row counts as recorded.
    const writeLedger = async (id: string): Promise<boolean> => {
      try {
        if (!orgId) throw new Error("property not found");
        const { error: ledgerError } = await admin.from("lead_events").insert({
          org_id: orgId,
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
    // Record the failed review id in the ledger BEFORE touching the hold, so
    // it survives a preserved timeout reason or a concurrent overwrite.
    const ledgerOk = await writeLedger(reviewId);
    // The existing reason may be the ONLY record of an earlier failure A whose
    // ledger write failed. Backfill A before overwriting it; if that fails,
    // keep A's reason (B is outstanding via its own ledger row).
    const existingId = suppressionReviewIdFromReason(existing);
    let keepEarlierSuppression = false;
    if (existingId && existingId !== reviewId) {
      const backfilled = await writeLedger(existingId);
      keepEarlierSuppression = !backfilled && ledgerOk;
    }
    // A send-timeout flag is a different, still-open problem: keep its
    // reason/timestamp and only (re)raise the hold - but only if the failed
    // id is durably in the ledger; otherwise the suppression reason wins.
    const keepReason =
      (isTimeoutEscalationReason(existing) && ledgerOk) || keepEarlierSuppression;
    const { error } = await admin
      .from("properties")
      .update(
        keepReason
          ? { needs_human_attention: true, updated_at: now }
          : {
              needs_human_attention: true,
              last_ai_escalation_reason: suppressionIncompleteReason(reviewId),
              last_ai_escalation_at: now,
              updated_at: now,
            },
      )
      .eq("id", propertyId);
    if (error) throw new Error(error.message);
  } catch (holdError) {
    reportError(holdError, {
      tags: { surface: "confirm_ai_disposition_suppression_hold" },
      extra: { reviewId, propertyId },
    });
  }
}

function isTimeoutEscalationReason(reason: string | null): boolean {
  return (
    !!reason &&
    (reason.startsWith("send_timeout:") ||
      reason.startsWith("dead_letter_failed:send_timeout:"))
  );
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
  actorId: string,
): Promise<ConfirmedSuppressionResult> {
  let heldPropertyId: string | null = null;
  try {
    const { data: review, error } = await supabase
      .from("ai_disposition_reviews")
      .select("property_id, org_id, disposition, ai_reason, source_inbound_message_id")
      .eq("id", reviewId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!review) throw new Error("review not found");
    heldPropertyId = review.property_id;
    if (review.disposition !== "opted_out" && review.disposition !== "dnc") {
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
    return await applyConfirmedSuppression({
      reviewId,
      contactId,
      phone,
      propertyId: review.property_id,
      orgId: review.org_id,
      disposition: review.disposition,
      actorId,
      aiReason: review.ai_reason,
    });
  } catch (error) {
    reportError(error, {
      tags: { surface: "confirm_ai_disposition_suppression_lookup" },
      extra: { reviewId },
    });
    if (heldPropertyId) await raiseSuppressionIncompleteHold(heldPropertyId, reviewId);
    return { ok: false, warning: SUPPRESSION_INCOMPLETE_WARNING };
  }
}
