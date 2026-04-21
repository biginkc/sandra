import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import {
  normalizeCountyName,
  normalizeStateCode,
  normalizeZip,
} from "./normalize";

/**
 * Resolve FIPS code from `(state, county name)`.
 * Returns null if state is not a recognized US state or the county row isn't seeded.
 *
 * The `fips_codes` table has a unique index on `(state_code, lower(county_name))`
 * so this lookup is case-insensitive by design. Uses `ilike` for the same effect.
 */
export async function resolveFipsFromCountyName(
  supabase: SupabaseClient<Database>,
  state: string | null | undefined,
  countyName: string | null | undefined,
): Promise<string | null> {
  const stateCode = normalizeStateCode(state);
  const county = normalizeCountyName(countyName);
  if (!stateCode || !county) return null;

  const { data, error } = await supabase
    .from("fips_codes")
    .select("fips_code")
    .eq("state_code", stateCode)
    .ilike("county_name", county)
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return data?.fips_code ?? null;
}

/**
 * Resolve FIPS code from a ZIP. Uses `zip_county_xref.is_primary=true` row
 * for the multi-county ZIPs; returns null for ZIPs not in the seed.
 */
export async function resolveFipsFromZip(
  supabase: SupabaseClient<Database>,
  zip: string | null | undefined,
): Promise<string | null> {
  const normalized = normalizeZip(zip);
  if (!normalized) return null;
  const zip5 = normalized.slice(0, 5);

  const { data, error } = await supabase
    .from("zip_county_xref")
    .select("fips_code")
    .eq("zip", zip5)
    .eq("is_primary", true)
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return data?.fips_code ?? null;
}

/**
 * Try county-name lookup first (most accurate), fall back to ZIP.
 * Returns null if neither path yields a FIPS code.
 */
export async function resolveFips(
  supabase: SupabaseClient<Database>,
  args: {
    state?: string | null;
    countyName?: string | null;
    zip?: string | null;
  },
): Promise<string | null> {
  if (args.countyName) {
    const byCounty = await resolveFipsFromCountyName(
      supabase,
      args.state,
      args.countyName,
    );
    if (byCounty) return byCounty;
  }
  if (args.zip) {
    return resolveFipsFromZip(supabase, args.zip);
  }
  return null;
}
