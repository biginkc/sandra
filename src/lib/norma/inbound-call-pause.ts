import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { pauseContactEnrollments } from "@/lib/sequences/enrollment";
import type { Database } from "@/lib/supabase/types";

/**
 * A seller calling back pauses their drips (Decided by Jarrad 2026-10-20),
 * mirroring the inbound-SMS pause. Call-backs to the voicemail drop number
 * forward to Norma, so the trigger is Norma's inbound call record: the
 * caller's phone is matched to contacts in the call's org (phone_1..3, the
 * same columns inbound SMS matches on). Nothing is paused without a match.
 */
export async function pauseEnrollmentsForInboundCall(
  client: SupabaseClient<Database>,
  inboundCallId: string,
): Promise<{ matchedContactIds: string[]; paused: number }> {
  const { data: call, error } = await client
    .from("norma_inbound_calls")
    .select("org_id, from_e164")
    .eq("id", inboundCallId)
    .maybeSingle();
  if (error) throw new Error(`pauseEnrollmentsForInboundCall call: ${error.message}`);
  const phone = normalizePhone(call?.from_e164);
  if (!call || !phone) return { matchedContactIds: [], paused: 0 };

  // Slots are stored as typed (raw 10-digit, punctuation, +1...), so narrow
  // by the last four digits (contiguous in every format) and compare after
  // normalizing each slot exactly as eligibility does.
  const last4 = phone.slice(-4);
  const { data: candidates, error: contactsError } = await client
    .from("contacts")
    .select("id, phone_1, phone_2, phone_3")
    .eq("org_id", call.org_id)
    .or(`phone_1.like.%${last4}%,phone_2.like.%${last4}%,phone_3.like.%${last4}%`);
  if (contactsError) throw new Error(`pauseEnrollmentsForInboundCall contacts: ${contactsError.message}`);
  const contactIds = new Set<string>();
  for (const row of candidates ?? []) {
    if ([row.phone_1, row.phone_2, row.phone_3].some((slot) => normalizePhone(slot) === phone)) contactIds.add(row.id);
  }

  let paused = 0;
  for (const contactId of contactIds) {
    paused += (await pauseContactEnrollments(client, { contactId, reason: "inbound_call" })).paused;
    paused += await takeOverAutoResumablePauses(client, contactId);
  }
  return { matchedContactIds: [...contactIds], paused };
}

/**
 * Pauses that resolve on their own would restart the drip after the seller
 * called. reconciliation_required (an unknown voicemail drop POST) advances
 * back to active when Drop Cowboy confirms the drop, and that advance is
 * fenced on pause_reason = 'reconciliation_required'; re-labelling it
 * inbound_call makes the call-back stick.
 */
export const AUTO_RESUMABLE_PAUSE_REASONS = ["reconciliation_required"] as const;

async function takeOverAutoResumablePauses(client: SupabaseClient<Database>, contactId: string): Promise<number> {
  const { data: properties, error: propertyError } = await client
    .from("properties")
    .select("id")
    .eq("homeowner_contact_id", contactId);
  if (propertyError) throw new Error(`pauseEnrollmentsForInboundCall properties: ${propertyError.message}`);
  const propertyIds = (properties ?? []).map((p) => p.id);
  if (propertyIds.length === 0) return 0;
  const { data, error } = await client
    .from("sequence_enrollments")
    .update({ pause_reason: "inbound_call", updated_at: new Date().toISOString() })
    .in("property_id", propertyIds)
    .eq("status", "paused")
    .in("pause_reason", [...AUTO_RESUMABLE_PAUSE_REASONS])
    .select("id");
  if (error) throw new Error(`pauseEnrollmentsForInboundCall takeover: ${error.message}`);
  return (data ?? []).length;
}
