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
 *
 * Two-client split (WR-02): the property/contact/org reads run on the
 * caller-supplied `client` (so RLS still applies in the inline-reply
 * path), while the `auth.admin.getUserById` call runs on `adminClient`
 * (which must be a service-role client). Cron callers can pass the same
 * service-role client for both — it bypasses RLS by design.
 */
export async function loadTemplateVars(
  client: SupabaseClient<Database>,
  params: {
    propertyId: string;
    contactId: string | null;
    enrolledByUserId: string | null;
  },
  adminClient?: SupabaseClient<Database>,
): Promise<TemplateVars> {
  // Fall back to the session client if no admin client was provided. This
  // preserves cron behavior (cron passes a service-role client as `client`,
  // so `auth.admin.getUserById` works on it). Inline-reply callers should
  // pass an explicit `adminClient` so the property/contact/org reads stay
  // RLS-scoped.
  const userResolverClient = adminClient ?? client;

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
        ? resolveUserFirstName(userResolverClient, params.enrolledByUserId)
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
 *
 * Requires a service-role client because `auth.admin.getUserById` is
 * not available on session clients.
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
