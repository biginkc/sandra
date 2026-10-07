import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { applyPhoneLevelOptOut } from "@/lib/messaging/opt-out-phone";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export const SUPPRESSION_INCOMPLETE_WARNING =
  "Confirmed, but suppression incomplete — retry.";

export const SUPPRESSION_INCOMPLETE_REASON = "suppression_incomplete";

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
    // A send-timeout flag is a different, still-open problem: keep its
    // reason/timestamp and only (re)raise the hold.
    const { data: current, error: readError } = await admin
      .from("properties")
      .select("last_ai_escalation_reason")
      .eq("id", propertyId)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    const existing: string | null = current?.last_ai_escalation_reason ?? null;
    const keepReason = isTimeoutEscalationReason(existing);
    const { error } = await admin
      .from("properties")
      .update(
        keepReason
          ? { needs_human_attention: true, updated_at: now }
          : {
              needs_human_attention: true,
              last_ai_escalation_reason: SUPPRESSION_INCOMPLETE_REASON,
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
