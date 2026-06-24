import type { SupabaseClient } from "@supabase/supabase-js";

import { getOutboundSenderName } from "@/lib/messaging/sender-persona";
import type { Database } from "@/lib/supabase/types";

import type { TemplateVars } from "./render";

/**
 * Build the variable map for a sequence step's template. Pulls per-lead
 * data from the DB; the set of variables exposed is the V1 whitelist:
 *
 *   first_name, last_name,
 *   property_address, city, state, property_zip,
 *   market,
 *   my_first_name, company_name
 *
 * Internal fields (lists, stack_count) are deliberately omitted — they
 * shouldn't leak into seller-facing SMS (Jarrad's rule 2026-04-23).
 *
 * `{{my_first_name}}` is the fixed outbound sender persona, not the
 * logged-in operator's auth profile.
 *
 * Property/contact/org reads run on the caller-supplied `client` so RLS
 * still applies in the inline-reply path. Cron callers pass a service-role
 * client and bypass RLS by design.
 */
export async function loadTemplateVars(
  client: SupabaseClient<Database>,
  params: {
    propertyId: string;
    contactId: string | null;
  },
): Promise<TemplateVars> {
  const [propertyResult, contactResult] = await Promise.all([
    client
      .from("properties")
      .select("address, city, state, zip, market, org_id")
      .eq("id", params.propertyId)
      .maybeSingle(),
    params.contactId
      ? client
          .from("contacts")
          .select("first_name, last_name")
          .eq("id", params.contactId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const property = propertyResult.data;
  const contact = contactResult.data;

  let companyName: string | null = null;
  if (property?.org_id) {
    const { data: org } = await client
      .from("organizations")
      .select("name")
      .eq("id", property.org_id)
      .maybeSingle();
    companyName = org?.name ?? null;
  }

  return {
    first_name: contact?.first_name ?? null,
    last_name: contact?.last_name ?? null,
    property_address: property?.address ?? null,
    city: property?.city ?? null,
    state: property?.state ?? null,
    property_zip: property?.zip ?? null,
    market: property?.market ?? null,
    my_first_name: getOutboundSenderName(),
    company_name: companyName,
  };
}
