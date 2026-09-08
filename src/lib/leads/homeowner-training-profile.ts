import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { isHomeownerTrainingNumber } from "@/lib/dialer/homeowner-training";

// Keep this factual context aligned with the seed and Switchboard persona revision.
// Persona revision: d49eb24670e6347c4367919473fc3cfadbe97087cd1b8b5896ec0e2921f43c51
export const JORDAN_MOTIVATION = "moving closer to an adult daughter and unable to fund repairs";

/** Display context only: call records and provider requests retain null customer references. */
export async function loadHomeownerTrainingProfile(client: SupabaseClient<Database>, phone: string) {
  if (!isHomeownerTrainingNumber(phone)) return null;
  const { data, error } = await client.from("properties")
    .select("id, address, state, source, is_vacant, absentee_flag, year_built, county:counties(name), homeowner:contacts!properties_homeowner_contact_id_fkey!inner(first_name, last_name, entity_name, phone_1)")
    .eq("is_training", true).eq("homeowner.phone_1", phone).limit(2);
  if (error) throw new Error("Could not load the internal training profile.");
  if ((data?.length ?? 0) > 1) throw new Error("The internal training profile is ambiguous.");
  return data?.[0] ?? null;
}
