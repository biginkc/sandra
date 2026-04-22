import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types";
import type { AddressInput, VerifiedAddress } from "./types";

/**
 * Cache of past CASS responses keyed by raw input address.
 *
 * Two wins:
 *   1. Repeat imports of the same address cost $0 until stale.
 *   2. The manual "Verify" button on lead detail re-uses results from the
 *      bulk child-job path, so a user who clicks Verify on a lead that was
 *      already auto-verified hits the cache.
 *
 * The key is the raw USER-supplied address (pre-verification), not the
 * USPS-standardized output. Two different raw strings that happen to
 * standardize to the same address get separate cache entries — each is
 * still a single DB hit, but the savings show up on true repeats.
 */

/**
 * USPS presort-eligibility window. After 150 days the mailing-industry
 * guidance is to re-verify before bulk mailing. Matches the plan.
 */
export const CASS_CACHE_STALE_DAYS = 150;

/**
 * Build the normalized cache key from an address input. Lowercased,
 * trimmed, whitespace-collapsed, joined by `|` so it stays readable if
 * we ever inspect the table by hand.
 */
export function buildCassCacheKey(input: AddressInput): string {
  const parts = [
    input.address,
    input.city ?? "",
    input.state ?? "",
    input.zip ?? "",
  ].map((p) =>
    String(p)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " "),
  );
  return parts.join("|");
}

export function isStale(
  verifiedAt: string | Date,
  now: Date = new Date(),
): boolean {
  const t = typeof verifiedAt === "string" ? new Date(verifiedAt) : verifiedAt;
  const ageMs = now.getTime() - t.getTime();
  return ageMs > CASS_CACHE_STALE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Look up a cached CASS result. Returns null on miss OR if the entry is
 * past the TTL — caller falls through to the live provider.
 */
export async function lookupCassCache(
  supabase: SupabaseClient<Database>,
  input: AddressInput,
): Promise<VerifiedAddress | null> {
  const key = buildCassCacheKey(input);
  const { data, error } = await supabase
    .from("cass_cache")
    .select("cass_response, verified_at")
    .eq("raw_address", key)
    .maybeSingle();

  if (error || !data) return null;
  if (isStale(data.verified_at)) return null;

  return data.cass_response as unknown as VerifiedAddress;
}

/**
 * Upsert a fresh CASS result. Touches verified_at on conflict so the TTL
 * clock resets for re-verified addresses.
 */
export async function writeCassCache(
  supabase: SupabaseClient<Database>,
  input: AddressInput,
  verified: VerifiedAddress,
): Promise<void> {
  const key = buildCassCacheKey(input);
  await supabase.from("cass_cache").upsert(
    {
      raw_address: key,
      cass_response: verified as unknown as Json,
      verified_at: new Date().toISOString(),
    },
    { onConflict: "raw_address" },
  );
}
