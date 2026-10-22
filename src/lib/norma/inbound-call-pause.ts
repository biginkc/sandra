import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { LEAD_EVENT_TYPES, recordLeadEvents } from "@/lib/events";
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
  if (!call) return { matchedContactIds: [], paused: 0 };
  return pauseEnrollmentsForCallerPhone(client, call.org_id, call.from_e164);
}

/**
 * Pause the drips of every contact in `orgId` whose phone_1..3 matches the
 * caller. Shared by Norma's inbound call record and Drop Cowboy's inbound
 * call webhook (which carries the real caller when the drop line forwards).
 */
export async function pauseEnrollmentsForCallerPhone(
  client: SupabaseClient<Database>,
  orgId: string,
  rawCallerPhone: string | null | undefined,
): Promise<{ matchedContactIds: string[]; paused: number }> {
  const phone = normalizePhone(rawCallerPhone);
  if (!phone) return { matchedContactIds: [], paused: 0 };

  // Slots are stored as typed (raw 10-digit, punctuation, +1...), so narrow
  // by the last four digits (contiguous in every format) and compare after
  // normalizing each slot exactly as eligibility does.
  const last4 = phone.slice(-4);
  const { data: candidates, error: contactsError } = await client
    .from("contacts")
    .select("id, phone_1, phone_2, phone_3")
    .eq("org_id", orgId)
    .or(`phone_1.like.%${last4}%,phone_2.like.%${last4}%,phone_3.like.%${last4}%`);
  if (contactsError) throw new Error(`pauseEnrollmentsForInboundCall contacts: ${contactsError.message}`);
  const contactIds = new Set<string>();
  for (const row of candidates ?? []) {
    if ([row.phone_1, row.phone_2, row.phone_3].some((slot) => normalizePhone(slot) === phone)) contactIds.add(row.id);
  }

  if (contactIds.size === 0) return { matchedContactIds: [], paused: 0 };
  // One atomic UPDATE (pause_enrollments_for_inbound_call): active rows,
  // reconciliation holds and temporary call pauses all become inbound_call,
  // so a call pause committing at the same moment cannot survive and be
  // resumed by the softphone / Norma release.
  const { data, error: pauseError } = await (
    client.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: Array<{ id: string; property_id: string; sequence_id: string }> | null; error: { message: string } | null }>
  )("pause_enrollments_for_inbound_call", { p_contact_ids: [...contactIds] });
  if (pauseError) throw new Error(`pauseEnrollmentsForInboundCall pause: ${pauseError.message}`);
  const rows = data ?? [];
  const grouped = new Map<string, string[]>();
  for (const row of rows) grouped.set(row.property_id, [...(grouped.get(row.property_id) ?? []), row.sequence_id]);
  if (grouped.size > 0) {
    const batchId = grouped.size > 1 ? crypto.randomUUID() : null;
    await recordLeadEvents(
      [...grouped.entries()].map(([propertyId, sequenceIds]) => ({
        propertyId,
        actorType: "system" as const,
        eventType: LEAD_EVENT_TYPES.SEQUENCE_PAUSED,
        payload: {
          count: sequenceIds.length,
          sequence_ids: [...new Set(sequenceIds)],
          reason: "inbound_call",
          permanent: false,
          ...(batchId ? { batch_id: batchId, batch_count: grouped.size } : {}),
        },
      })),
    );
  }
  return { matchedContactIds: [...contactIds], paused: rows.length };
}
