import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import type { Database } from "@/lib/supabase/types";
const PHONE_SUPPRESSION_CHUNK = 250;

/** Read-only, batch phone-suppression lookup shared by queueing and CLI previews. */
export async function loadSuppressedSmsPhoneSet(
  supabase: SupabaseClient<Database>,
  rawPhones: Iterable<string | null | undefined>,
  orgId: string | null | undefined,
): Promise<Set<string>> {
  if (!orgId) return new Set<string>();
  const phones = Array.from(
    new Set(
      Array.from(rawPhones)
        .map((phone) => normalizePhone(phone ?? ""))
        .filter((phone): phone is string => typeof phone === "string"),
    ),
  );
  if (phones.length === 0) return new Set<string>();

  const suppressed = new Set<string>();
  for (let offset = 0; offset < phones.length; offset += PHONE_SUPPRESSION_CHUNK) {
    const { data, error } = await supabase.from("sms_phone_suppressions").select("phone_e164").eq("org_id", orgId).eq("channel", "sms").in("phone_e164", phones.slice(offset, offset + PHONE_SUPPRESSION_CHUNK));
    if (error) throw new Error(`loadSuppressedSmsPhoneSet: ${error.message}`);
    for (const row of data ?? []) suppressed.add(row.phone_e164);
  }
  return suppressed;
}
