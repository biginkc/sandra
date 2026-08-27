"use server";

import { revalidatePath } from "next/cache";

import { recordConsentEvent } from "@/lib/messaging/consent";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { qualifyProperty } from "@/lib/leads/qualify";
import { pauseContactEnrollments } from "@/lib/sequences/enrollment";
import { createClient } from "@/lib/supabase/server";

// "booked_appointment" is set only by `fn_book_appointment`
// (components/appointments/book-appointment-action.ts), never through
// `setOutreachDispo` — same as `callback_requested` just above this type,
// which is likewise absent from the union and from VALID_DISPOS/
// TRIGGERS_OPT_OUT below and exists only as a display label downstream
// (inbox-detail.tsx, inbox-thread-list.tsx). Both values are legal
// `properties.outreach_dispo` values at the DB level without being
// client-settable dispos.
export type OutreachDispo =
  | "wrong_number"
  | "bad_number"
  | "not_interested"
  | "needs_sequence"
  | "nurture"
  | "opted_out"
  | "dnc";

const VALID_DISPOS: ReadonlySet<string> = new Set<OutreachDispo>([
  "wrong_number",
  "bad_number",
  "not_interested",
  "needs_sequence",
  "nurture",
  "opted_out",
  "dnc",
]);

/** Dispos that also trigger TCPA opt-out (consent_events + sms_opted_out). */
const TRIGGERS_OPT_OUT: ReadonlySet<OutreachDispo> = new Set([
  "dnc",
  "opted_out",
]);

export type SetDispoResult =
  | { ok: true }
  | { ok: false; error: string };

export type ConfirmAiDispositionReviewResult =
  | { ok: true; status: "confirmed" | "superseded" }
  | { ok: false; error: string };

export async function confirmAiDispositionReview(
  reviewId: string,
): Promise<ConfirmAiDispositionReviewResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in" };

  const { data, error } = await supabase.rpc(
    "fn_confirm_ai_disposition_review",
    { p_review_id: reviewId },
  );
  if (error) return { ok: false, error: error.message };

  const status = readReviewResolutionStatus(data);
  if (!status) {
    reportError(new Error("Unexpected AI disposition confirmation response"), {
      tags: { surface: "confirm_ai_disposition_review" },
      extra: { reviewId, response: data },
    });
    return { ok: false, error: "Could not confirm Sandra's disposition" };
  }

  try {
    revalidatePath("/messages");
  } catch (revalidateError) {
    reportError(revalidateError, {
      tags: { surface: "confirm_ai_disposition_review_revalidate" },
      extra: { reviewId, status },
    });
  }
  return { ok: true, status };
}

function readReviewResolutionStatus(
  value: unknown,
): "confirmed" | "superseded" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = (value as Record<string, unknown>).status;
  return status === "confirmed" || status === "superseded" ? status : null;
}

export async function setOutreachDispo(
  propertyId: string,
  dispo: OutreachDispo,
): Promise<SetDispoResult> {
  if (!VALID_DISPOS.has(dispo)) {
    return { ok: false, error: `Unknown dispo: ${dispo}` };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Not signed in" };
  }

  const { data: prop, error: propErr } = await supabase
    .from("properties")
    .select("id, homeowner_contact_id, outreach_dispo")
    .eq("id", propertyId)
    .maybeSingle();

  if (propErr || !prop) {
    return { ok: false, error: propErr?.message ?? "Property not found" };
  }

  const now = new Date();
  let updateQuery = supabase
    .from("properties")
    .update({
      outreach_dispo: dispo,
      follow_up_at: null,
      updated_at: now.toISOString(),
    })
    .eq("id", propertyId);
  updateQuery = prop.outreach_dispo === null
    ? updateQuery.is("outreach_dispo", null)
    : updateQuery.eq("outreach_dispo", prop.outreach_dispo);
  const { error: updateErr, data: updated } = await updateQuery
    .select("id")
    .maybeSingle();

  if (updateErr) {
    return { ok: false, error: updateErr.message };
  }
  if (!updated) {
    return {
      ok: false,
      error: "Disposition changed in another session. Refresh and try again.",
    };
  }

  if (prop.outreach_dispo !== dispo) {
    try {
      await recordLeadEvent({
        propertyId,
        eventType: LEAD_EVENT_TYPES.DISPO_SET,
        actorType: "user",
        actorId: user.id,
        payload: { from: prop.outreach_dispo, to: dispo },
      });
    } catch (eventError) {
      // The property update (and the database trigger that supersedes any AI
      // review) already committed. Do not tell the operator the correction
      // failed because a secondary activity-feed append had trouble.
      reportError(eventError, {
        tags: { surface: "manual_dispo_event_after_commit" },
        extra: { propertyId, dispo, userId: user.id },
      });
    }
  }

  // TCPA suppression — fire consent event + flip boolean + pause enrollments.
  if (TRIGGERS_OPT_OUT.has(dispo) && prop.homeowner_contact_id) {
    const contactId = prop.homeowner_contact_id;
    const { data: contact, error: contactReadError } = await supabase
      .from("contacts")
      .select("do_not_contact, sms_opted_out")
      .eq("id", contactId)
      .maybeSingle();
    if (contactReadError || !contact) {
      reportError(
        new Error(contactReadError?.message ?? "Contact not found"),
        {
          tags: { surface: "manual_dispo_contact_read_after_commit" },
          extra: { propertyId, contactId, dispo },
        },
      );
    } else if (!contact.do_not_contact && !contact.sms_opted_out) {
      const { data: claimedContact, error: contactUpdateError } = await supabase
        .from("contacts")
        .update({
          sms_opted_out: true,
          sms_opted_out_at: now.toISOString(),
        })
        .eq("id", contactId)
        .eq("do_not_contact", false)
        .eq("sms_opted_out", false)
        .select("id")
        .maybeSingle();
      if (
        contactUpdateError &&
        !contactUpdateError.message.includes("DNC_LOCKED")
      ) {
        reportError(new Error(contactUpdateError.message), {
          tags: { surface: "manual_dispo_contact_update_after_commit" },
          extra: { propertyId, contactId, dispo },
        });
      } else if (claimedContact) {
        try {
          const consentOutcome = await recordConsentEvent(supabase, {
            contactId,
            channel: "sms",
            eventType: "opt_out",
            source: "manual_dispo",
            sourceDetail: { propertyId, dispo },
            occurredAt: now,
          });
          if (consentOutcome.inserted) {
            await recordLeadEvent({
              propertyId,
              eventType: LEAD_EVENT_TYPES.OPTED_OUT,
              actorType: "user",
              actorId: user.id,
              payload: { channel: "sms", trigger: "manual_disposition" },
              sourceType: "consent_events.opt_out",
              sourceId: consentOutcome.id,
            });
          }
        } catch (error) {
          reportError(error, {
            tags: { surface: "manual_dispo_consent_after_commit" },
            extra: { propertyId, contactId, dispo },
          });
        }
      }
    }
    try {
      await pauseContactEnrollments(supabase, {
        contactId,
        reason: "consent_revoked",
        permanent: true,
        actor: { actorType: "user", actorId: user.id },
      });
    } catch (error) {
      reportError(error, {
        tags: { surface: "manual_dispo_sequence_pause_after_commit" },
        extra: { propertyId, contactId, dispo },
      });
    }
  }

  for (const path of ["/messages", "/properties"]) {
    try {
      revalidatePath(path);
    } catch (error) {
      reportError(error, {
        tags: { surface: "manual_dispo_revalidate_after_commit" },
        extra: { propertyId, dispo, path },
      });
    }
  }

  return { ok: true };
}

export type MoveMessageThreadToLeadResult =
  | { ok: true; alreadyQualified: boolean }
  | { ok: false; error: string };

export async function moveMessageThreadToLead(
  propertyId: string,
): Promise<MoveMessageThreadToLeadResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Not signed in" };
  }

  try {
    const outcome = await qualifyProperty(supabase, propertyId, user.id);
    switch (outcome.status) {
      case "qualified":
        revalidatePath("/messages");
        revalidatePath("/leads");
        revalidatePath(`/leads/${propertyId}`);
        revalidatePath("/properties");
        return { ok: true, alreadyQualified: false };
      case "already_qualified":
        revalidatePath("/messages");
        revalidatePath(`/leads/${propertyId}`);
        return { ok: true, alreadyQualified: true };
      case "not_found":
        return { ok: false, error: "Property not found" };
      case "failed":
        return { ok: false, error: outcome.message };
    }
  } catch (e) {
    reportError(e, {
      tags: { surface: "move_message_thread_to_lead" },
      extra: { propertyId },
    });
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not move to lead",
    };
  }
}
