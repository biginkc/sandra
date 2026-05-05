"use server";

import { revalidatePath } from "next/cache";

import { recordConsentEvent } from "@/lib/messaging/consent";
import { pauseContactEnrollments } from "@/lib/sequences/enrollment";
import { createClient } from "@/lib/supabase/server";

export type OutreachDispo =
  | "wrong_number"
  | "bad_number"
  | "not_interested"
  | "opted_out"
  | "dnc"
  | "nurture"
  | "callback_requested";

const VALID_DISPOS: ReadonlySet<string> = new Set<OutreachDispo>([
  "wrong_number",
  "bad_number",
  "not_interested",
  "opted_out",
  "dnc",
  "nurture",
  "callback_requested",
]);

/** Dispos that require follow_up_at to be set. */
const REQUIRES_FOLLOW_UP: ReadonlySet<OutreachDispo> = new Set([
  "nurture",
  "callback_requested",
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
  followUpAt?: string | null,
): Promise<SetDispoResult> {
  if (!VALID_DISPOS.has(dispo)) {
    return { ok: false, error: `Unknown dispo: ${dispo}` };
  }
  if (REQUIRES_FOLLOW_UP.has(dispo) && !followUpAt) {
    return { ok: false, error: `${dispo} requires a follow-up date` };
  }

  const supabase = await createClient();

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
      follow_up_at: followUpAt ?? null,
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
    });
  }

  revalidatePath("/messages");
  revalidatePath("/properties");

  return { ok: true };
}
