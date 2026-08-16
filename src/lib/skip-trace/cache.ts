import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types";

import type { SkipTraceResult } from "./types";

/**
 * Per-provider per-address skip-trace cache. 90-day TTL enforced at
 * read time — there's no cron-cleanup yet (the table is small enough
 * that ~10K stale rows are harmless).
 *
 * Keying choice (per-provider, per-address) intentionally allows two
 * providers' results to coexist for the same property — useful when a
 * future waterfall escalates to a more accurate provider.
 */
const TTL_DAYS = 90;

export function normalizeAddress(parts: {
  address: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string {
  return [parts.address, parts.city, parts.state, parts.zip]
    .filter((v): v is string => !!v)
    .map((v) => v.trim().toLowerCase())
    .join("|");
}

/**
 * Address key used to match Tracerfy batch results back to our
 * properties. Deliberately omits zip — Tracerfy's batch response
 * returns address/city/state only, so submit-time and finalize-time
 * keys must agree on the same shape.
 */
export function normalizeAddressForMatch(parts: {
  address: string;
  city?: string | null;
  state?: string | null;
}): string {
  return [parts.address, parts.city, parts.state]
    .filter((v): v is string => !!v)
    .map((v) => v.trim().toLowerCase())
    .join("|");
}

export type CachedSkipTrace = {
  result: SkipTraceResult;
  /** When the cache row was written. Caller can use this for "skip-traced N
   *  days ago" UI. */
  cachedAt: string;
};

export async function readCache(
  supabase: SupabaseClient<Database>,
  orgId: string,
  provider: string,
  addressNormalized: string,
): Promise<CachedSkipTrace | null> {
  const cutoff = new Date(
    Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("skip_trace_cache")
    .select("result, created_at")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .eq("address_normalized", addressNormalized)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`skip-trace cache read failed: ${error.message}`);
  }

  if (!data) return null;
  return {
    result: data.result as unknown as SkipTraceResult,
    cachedAt: data.created_at,
  };
}

/**
 * Bulk variant of readCache: one round-trip per ~150 addresses instead of
 * one per row. Returns a map keyed by address_normalized holding the
 * NEWEST in-TTL cache row per address. Added for the 10K bulk skip-trace
 * path — the per-row loop was a hidden N+1 that would have pushed a large
 * job's pre-submit phase past the function ceiling.
 */
export async function readCacheMany(
  supabase: SupabaseClient<Database>,
  orgId: string,
  provider: string,
  addressesNormalized: string[],
): Promise<Map<string, CachedSkipTrace>> {
  const out = new Map<string, CachedSkipTrace>();
  if (addressesNormalized.length === 0) return out;

  const cutoff = new Date(
    Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Addresses ride in the GET query string — keep chunks small enough to
  // stay clear of URL length limits.
  const CHUNK = 150;
  const unique = Array.from(new Set(addressesNormalized));
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("skip_trace_cache")
      .select("address_normalized, result, created_at")
      .eq("org_id", orgId)
      .eq("provider", provider)
      .in("address_normalized", slice)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`skip-trace cache bulk read failed: ${error.message}`);
    }

    for (const row of data ?? []) {
      // Rows arrive newest-first; first write per address wins.
      if (!out.has(row.address_normalized)) {
        out.set(row.address_normalized, {
          result: row.result as unknown as SkipTraceResult,
          cachedAt: row.created_at,
        });
      }
    }
  }
  return out;
}

export async function writeCache(
  supabase: SupabaseClient<Database>,
  orgId: string,
  provider: string,
  addressNormalized: string,
  result: SkipTraceResult,
): Promise<void> {
  const matchCount = result.persons.reduce(
    (n, p) => n + p.phones.length + p.emails.length,
    0,
  );

  // Cache identity is tenant + provider + address. Never reuse a paid result
  // across organizations that happen to track the same property address.
  const { error } = await supabase.from("skip_trace_cache").upsert(
    {
      org_id: orgId,
      provider,
      address_normalized: addressNormalized,
      result: result as unknown as Json,
      match_count: matchCount,
      cost_credits: result.creditsDeducted,
    },
    { onConflict: "org_id,provider,address_normalized" },
  );
  if (error) {
    throw new Error(`skip-trace cache write failed: ${error.message}`);
  }
}
