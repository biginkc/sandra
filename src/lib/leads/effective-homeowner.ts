import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * Lead imports since 2026-10-22 (DealMachine person rows, Assigns) link
 * people through `property_contacts` and leave `properties.homeowner_contact_id`
 * empty. Surfaces keyed on the homeowner column then treat the lead as having
 * nobody to text, even when that person has already replied.
 *
 * Resolve, in order: the saved homeowner; the contact on this lead's newest
 * inbound message (reply to whoever texted); the first linked contact.
 */
export async function resolveEffectiveHomeownerContactId(
  supabase: SupabaseClient<Database>,
  input: { propertyId: string; homeownerContactId: string | null },
): Promise<string | null> {
  if (input.homeownerContactId) return input.homeownerContactId;

  const { data: inbound, error: inboundError } = await supabase
    .from("messages")
    .select("contact_id")
    .eq("property_id", input.propertyId)
    .eq("direction", "inbound")
    .not("contact_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (inboundError) throw inboundError;
  if (inbound?.contact_id) return inbound.contact_id;

  const { data: linked, error: linkedError } = await supabase
    .from("property_contacts")
    .select("contact_id")
    .eq("property_id", input.propertyId)
    .order("source_position", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (linkedError) throw linkedError;
  return linked?.contact_id ?? null;
}
