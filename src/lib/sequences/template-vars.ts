import type { SupabaseClient } from "@supabase/supabase-js";

import { getOutboundSenderName } from "@/lib/messaging/sender-persona";
import type { Database } from "@/lib/supabase/types";

import {
  computeRapidOffer,
  formatRapidOffer,
  resolveRapidOfferPct,
  resolveRapidOfferSource,
  type RapidOfferMeta,
} from "@/lib/templates/rapid-offer";

import type { TemplateVars } from "./render";

export type TemplateVarsWithMeta = {
  vars: TemplateVars;
  rapidOffer: RapidOfferMeta | null;
};

/**
 * Build the variable map for a sequence step's template. Pulls per-lead
 * data from the DB; the set of variables exposed is the V1 whitelist:
 *
 *   first_name, last_name,
 *   property_address, city, state, property_zip,
 *   market,
 *   my_first_name, company_name,
 *   rapid_offer (75% of properties.arv, "" when none)
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
  return (await loadTemplateVarsWithMeta(client, params)).vars;
}

/**
 * Same as `loadTemplateVars`, plus the pieces behind `{{rapid_offer}}`
 * so callers can log how the offer was computed.
 */
export async function loadTemplateVarsWithMeta(
  client: SupabaseClient<Database>,
  params: {
    propertyId: string;
    contactId: string | null;
  },
): Promise<TemplateVarsWithMeta> {
  const [propertyResult, contactResult] = await Promise.all([
    client
      .from("properties")
      .select("address, city, state, zip, market, org_id, arv")
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

  const arv = typeof property?.arv === "number" ? property.arv : null;
  const source = resolveRapidOfferSource({ arv });
  const pct = resolveRapidOfferPct();
  const amount = source ? computeRapidOffer(source.value, pct) : null;
  const rapidOffer: RapidOfferMeta | null =
    source && amount !== null
      ? { amount, sourceValue: source.value, source: source.source, pct }
      : null;

  const vars: TemplateVars = {
    first_name: contact?.first_name ?? null,
    last_name: contact?.last_name ?? null,
    property_address: property?.address ?? null,
    city: property?.city ?? null,
    state: property?.state ?? null,
    property_zip: property?.zip ?? null,
    market: property?.market ?? null,
    my_first_name: getOutboundSenderName(),
    company_name: companyName,
    rapid_offer: rapidOffer ? formatRapidOffer(rapidOffer.amount) : "",
  };
  return { vars, rapidOffer };
}
