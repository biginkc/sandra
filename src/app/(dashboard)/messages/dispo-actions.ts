"use server";

import { revalidatePath } from "next/cache";

import { recordConsentEvent } from "@/lib/messaging/consent";
import { reportError } from "@/lib/errors/report";
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
    .select("id, homeowner_contact_id")
    .eq("id", propertyId)
    .maybeSingle();

  if (propErr || !prop) {
    return { ok: false, error: propErr?.message ?? "Property not found" };
  }

  const { error: updateErr } = await supabase
    .from("properties")
    .update({
      outreach_dispo: dispo,
      follow_up_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", propertyId);

  if (updateErr) {
    return { ok: false, error: updateErr.message };
  }

  // TCPA suppression — fire consent event + flip boolean + pause enrollments.
  if (TRIGGERS_OPT_OUT.has(dispo) && prop.homeowner_contact_id) {
    const contactId = prop.homeowner_contact_id;
    await recordConsentEvent(supabase, {
      contactId,
      channel: "sms",
      eventType: "opt_out",
      source: "manual_dispo",
      sourceDetail: { propertyId, dispo },
      occurredAt: new Date(),
    });
    await supabase
      .from("contacts")
      .update({
        sms_opted_out: true,
        sms_opted_out_at: new Date().toISOString(),
      })
      .eq("id", contactId);
    await pauseContactEnrollments(supabase, {
      contactId,
      reason: "consent_revoked",
      permanent: true,
      actor: { actorType: "user", actorId: user.id },
    });
  }

  revalidatePath("/messages");
  revalidatePath("/properties");

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
