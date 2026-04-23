import type { SupabaseClient } from "@supabase/supabase-js";

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
 * `enrolledByUserId` feeds `{{my_first_name}}` — derived from the
 * authoring VA's email via `listOrgUsers`-style lookup. Falls back to
 * blank when unknown; the conditional wrapper in the starter templates
 * handles that gracefully.
 */
export async function loadTemplateVars(
  client: SupabaseClient<Database>,
  params: {
    propertyId: string;
    contactId: string | null;
    enrolledByUserId: string | null;
  },
): Promise<TemplateVars> {
  const [propertyResult, contactResult, orgNameResult, userResult] =
    await Promise.all([
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
      // org name is looked up from the property's org_id; deferred until
      // we know property exists.
      Promise.resolve(null),
      params.enrolledByUserId
        ? resolveUserFirstName(client, params.enrolledByUserId)
        : Promise.resolve(null),
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
    my_first_name: userResult ?? null,
    company_name: companyName,
  };
}

/**
 * Resolve a user id to their first-name-like display string. We use the
 * local part of their email (before the `@`) since Supabase doesn't
 * ship with a profile name by default. Falls back to null on any error.
 */
async function resolveUserFirstName(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<string | null> {
  try {
    const { data } = await client.auth.admin.getUserById(userId);
    const email = data?.user?.email;
    if (!email) return null;
    // "jarrad@bmhgroupkc.com" → "jarrad"
    // Capitalize first letter for a friendlier rendered SMS.
    const local = email.split("@")[0];
    if (!local) return null;
    return local.charAt(0).toUpperCase() + local.slice(1);
  } catch {
    return null;
  }
}
