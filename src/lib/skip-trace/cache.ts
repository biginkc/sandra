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
  provider: string,
  addressNormalized: string,
): Promise<CachedSkipTrace | null> {
  const cutoff = new Date(
    Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data } = await supabase
    .from("skip_trace_cache")
    .select("result, created_at")
    .eq("provider", provider)
    .eq("address_normalized", addressNormalized)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return {
    result: data.result as unknown as SkipTraceResult,
    cachedAt: data.created_at,
  };
}

export async function writeCache(
  supabase: SupabaseClient<Database>,
  provider: string,
  addressNormalized: string,
  result: SkipTraceResult,
): Promise<void> {
  const matchCount = result.persons.reduce(
    (n, p) => n + p.phones.length + p.emails.length,
    0,
  );

  // upsert by (provider, address_normalized) — unique index on those.
  await supabase.from("skip_trace_cache").upsert(
    {
      provider,
      address_normalized: addressNormalized,
      result: result as unknown as Json,
      match_count: matchCount,
      cost_credits: result.creditsDeducted,
    },
    { onConflict: "provider,address_normalized" },
  );
}
