import "server-only";

import { assertNotTrainingTarget } from "@/lib/leads/training";
import { revalidatePath } from "next/cache";

import { computeConsentState, recordConsentEvent } from "@/lib/messaging/consent";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { pauseContactEnrollments } from "@/lib/sequences/enrollment";
import { startFollowUpDrip, type DripResult } from "@/lib/sequences/start-drip";
import { createClient } from "@/lib/supabase/server";

/**
 * Shared outreach-disposition saver. Deliberately NOT a "use server" module:
 * it is not a public endpoint, so it performs no workspace check itself.
 * Callers own authorization — the Messages server actions call
 * `assertMessagesWorkspaceAccess()` first, and the dialer's own actions
 * authenticate the rep before wrap-up.
 */
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
  | { ok: true; enrollment?: Pick<DripResult, "status" | "reason"> }
  | {
      ok: false;
      error: string;
      /**
       * Internal: the property disposition is already saved but the opt-out
       * suppression did not complete. Retrying the same dispo is safe.
       */
      committed?: boolean;
    };

export async function saveOutreachDispo(
  propertyId: string,
  dispo: OutreachDispo,
  sequenceId?: string,
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
    .select("id, homeowner_contact_id, outreach_dispo, is_dnc_locked")
    .eq("id", propertyId)
    .maybeSingle();

  if (propErr || !prop) {
    return { ok: false, error: propErr?.message ?? "Property not found" };
  }
  if ((dispo === "needs_sequence" || dispo === "nurture" || dispo === "not_interested") &&
      (prop.is_dnc_locked || prop.outreach_dispo === "dnc" || prop.outreach_dispo === "opted_out")) {
    return { ok: false, error: "This lead is do not contact or opted out. Its follow-up outcome cannot be changed." };
  }

  try {
    await assertNotTrainingTarget(supabase, { propertyId });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Training eligibility could not be verified." };
  }

  const now = new Date();
  // Retrying an opt-out/DNC save whose suppression step failed: the property
  // already holds this dispo (and a DNC-locked row must not be mutated again),
  // so skip the property UPDATE and re-run the suppression branch only.
  const suppressionRecovery =
    TRIGGERS_OPT_OUT.has(dispo) && prop.outreach_dispo === dispo;

  // Cache invalidation is owed whenever a property write committed or the
  // suppression branch ran, on success and on failure.
  let revalidateOwed = false;

  if (!suppressionRecovery) {
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
    if (dispo === "needs_sequence" || dispo === "nurture" || dispo === "not_interested") updateQuery = updateQuery.eq("is_dnc_locked", false);
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
    revalidateOwed = true;
  }

  try {
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
    // The property dispo is already saved here, so any failure is reported as
    // a committed failure: the caller must not treat the opt-out as complete,
    // and a retry (same dispo) re-runs this branch idempotently.
    if (TRIGGERS_OPT_OUT.has(dispo) && prop.homeowner_contact_id) {
      revalidateOwed = true;
      const contactId = prop.homeowner_contact_id;
      const { data: contact, error: contactReadError } = await supabase
        .from("contacts")
        .select("do_not_contact, sms_opted_out")
        .eq("id", contactId)
        .maybeSingle();
      if (contactReadError || !contact) {
        const message = contactReadError?.message ?? "Contact not found";
        reportError(new Error(message), {
          tags: { surface: "manual_dispo_contact_read_after_commit" },
          extra: { propertyId, contactId, dispo },
        });
        return { ok: false, error: message, committed: true };
      }
      if (!contact.do_not_contact && !contact.sms_opted_out) {
        const { error: contactUpdateError } = await supabase
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
          return { ok: false, error: contactUpdateError.message, committed: true };
        }
      }

      // Same shape as getConsentState, but a read failure must not be mapped
      // to "no_consent" (which would risk a duplicate or a skipped record).
      const { data: consentRows, error: consentReadError } = await supabase
        .from("consent_events")
        .select("event_type, occurred_at")
        .eq("contact_id", contactId)
        .eq("channel", "sms")
        .order("occurred_at", { ascending: false })
        .limit(20);
      if (consentReadError) {
        reportError(new Error(consentReadError.message), {
          tags: { surface: "manual_dispo_consent_read_after_commit" },
          extra: { propertyId, contactId, dispo },
        });
        return { ok: false, error: consentReadError.message, committed: true };
      }
      if (computeConsentState(consentRows ?? []) !== "opted_out") {
        let consentOutcome: Awaited<ReturnType<typeof recordConsentEvent>>;
        try {
          consentOutcome = await recordConsentEvent(supabase, {
            contactId,
            channel: "sms",
            eventType: "opt_out",
            source: "manual_dispo",
            sourceDetail: { propertyId, dispo },
            occurredAt: now,
          });
        } catch (error) {
          reportError(error, {
            tags: { surface: "manual_dispo_consent_after_commit" },
            extra: { propertyId, contactId, dispo },
          });
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            committed: true,
          };
        }
        if (consentOutcome.inserted) {
          try {
            await recordLeadEvent({
              propertyId,
              eventType: LEAD_EVENT_TYPES.OPTED_OUT,
              actorType: "user",
              actorId: user.id,
              payload: { channel: "sms", trigger: "manual_disposition" },
              sourceType: "consent_events.opt_out",
              sourceId: consentOutcome.id,
            });
          } catch (error) {
            // Consent is recorded; a retry would see opted_out and not
            // repeat it, so the activity-feed append is report-only.
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
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          committed: true,
        };
      }
    }
  } finally {
    if (revalidateOwed) {
      for (const path of ["/messages", "/properties", `/leads/${propertyId}`]) {
        try {
          revalidatePath(path);
        } catch (error) {
          reportError(error, {
            tags: { surface: "manual_dispo_revalidate_after_commit" },
            extra: { propertyId, dispo, path },
          });
        }
      }
    }
  }

  if (sequenceId && dispo === "needs_sequence") {
    try {
      const { results } = await startFollowUpDrip(supabase, { propertyIds: [propertyId], sequenceId, userId: user.id });
      return { ok: true, enrollment: { status: results[0].status, reason: results[0].reason } };
    } catch (error) {
      reportError(error, { tags: { surface: "manual_dispo_enroll_after_commit" }, extra: { propertyId, sequenceId } });
      return { ok: true, enrollment: { status: "failed", reason: "Could not enroll this lead." } };
    }
  }
  return { ok: true };
}
