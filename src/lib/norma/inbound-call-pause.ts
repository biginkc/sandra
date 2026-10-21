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

  const results = await Promise.all(
    (["phone_1", "phone_2", "phone_3"] as const).map((column) =>
      client.from("contacts").select("id").eq("org_id", call.org_id).eq(column, phone),
    ),
  );
  const contactIds = new Set<string>();
  for (const result of results) {
    if (result.error) throw new Error(`pauseEnrollmentsForInboundCall contacts: ${result.error.message}`);
    for (const row of result.data ?? []) contactIds.add(row.id);
  }

  let paused = 0;
  for (const contactId of contactIds) {
    paused += (await pauseContactEnrollments(client, { contactId, reason: "inbound_call" })).paused;
  }
  return { matchedContactIds: [...contactIds], paused };
}
