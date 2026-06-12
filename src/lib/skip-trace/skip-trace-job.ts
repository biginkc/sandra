import type { SupabaseClient } from "@supabase/supabase-js";

import { ConfigurationError, ProviderError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import { dispatchJobCompleted } from "@/lib/notifications/dispatch";
import type { Database, Json } from "@/lib/supabase/types";

import {
  normalizeAddress,
  normalizeAddressForMatch,
  readCacheMany,
  writeCache,
} from "./cache";
import { persistSkipTraceResult, type PersistOutcome } from "./persist-result";
import { getSkipTraceProvider } from "./registry";
import type { SkipTraceInput, SkipTraceResult } from "./types";

/**
 * Drive a skip-trace job to completion (or to a `running` state with a
 * pending batch queueId, when the work is large enough to justify the
 * async path).
 *
 * Mirrors `runCassEnrichment` in shape but splits two ways:
 *   - sync:  ≤1 miss → POST /trace/lookup/, persist, mark complete
 *   - async: ≥2 misses → POST /trace/, store queue_id, exit. Webhook
 *            (or polling) finalizes via `finalizeSkipTraceFromBatch`.
 *
 * Cache reads happen first; cached rows never hit the provider.
 *
 * Never throws — errors are absorbed into the job row + reported.
 */

/** PostgREST .in() rides in the URL — chunk large ID lists to stay clear
 *  of URL length limits. 500 UUIDs ≈ 18KB of query string per request. */
const IN_CHUNK = 500;

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type SkipTraceJobSummary = {
  total: number;
  matched: number;
  no_match: number;
  failed: number;
  cached_hits: number;
  api_hits: number;
  total_credits: number;
};

export async function runSkipTraceEnrichment(
  supabase: SupabaseClient<Database>,
  params: { jobId: string; propertyIds: string[] },
): Promise<SkipTraceJobSummary | { pending: true; queueId: string }> {
  const summary: SkipTraceJobSummary = {
    total: params.propertyIds.length,
    matched: 0,
    no_match: 0,
    failed: 0,
    cached_hits: 0,
    api_hits: 0,
    total_credits: 0,
  };

  await supabase
    .from("jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      total_items: params.propertyIds.length,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", params.jobId);

  // ------------------------------------------------------------------
  // 0. Resolve provider
  // ------------------------------------------------------------------
  let provider;
  try {
    provider = getSkipTraceProvider();
  } catch (e) {
    if (e instanceof ConfigurationError) {
      await markJobCanceled(supabase, params.jobId, e.message);
      return summary;
    }
    throw e;
  }
  if (!provider) {
    await markJobCanceled(supabase, params.jobId, "Skip-trace provider disabled");
    return summary;
  }

  // ------------------------------------------------------------------
  // 1. Load properties + check cache. Build:
  //    - cachedResults: results we can persist immediately
  //    - misses: properties needing a real provider call
  // ------------------------------------------------------------------
  // Pull property + the homeowner's mailing address (if any) in two
  // shots — Supabase's PostgREST joins via the homeowner_contact_id FK
  // would also work, but the explicit two-query path keeps the type
  // story simple and the mailing-fields-may-be-null branch obvious.
  const properties: Array<{
    id: string;
    address: string;
    city: string | null;
    state: string;
    zip: string | null;
    homeowner_contact_id: string | null;
    cass_status: string;
  }> = [];
  for (const ids of chunked(params.propertyIds, IN_CHUNK)) {
    const { data } = await supabase
      .from("properties")
      .select("id, address, city, state, zip, homeowner_contact_id, cass_status")
      .in("id", ids);
    if (data) properties.push(...data);
  }

  if (properties.length === 0) {
    await markJobFailed(supabase, params.jobId, "No properties found");
    return summary;
  }

  const homeownerIds = properties
    .map((p) => p.homeowner_contact_id)
    .filter((id): id is string => typeof id === "string");

  const homeowners: Array<{
    contact_id: string;
    mailing_address: string | null;
    mailing_city: string | null;
    mailing_state: string | null;
    mailing_zip: string | null;
  }> = [];
  for (const ids of chunked(homeownerIds, IN_CHUNK)) {
    const { data } = await supabase
      .from("homeowner_details")
      .select(
        "contact_id, mailing_address, mailing_city, mailing_state, mailing_zip",
      )
      .in("contact_id", ids);
    if (data) homeowners.push(...data);
  }

  const mailingByContact = new Map(
    homeowners.map((h) => [h.contact_id, h]),
  );

  const cachedResults: SkipTraceResult[] = [];
  const misses: SkipTraceInput[] = [];
  const propsById = new Map(properties.map((p) => [p.id, p]));

  // Pass 1: normalize every address, then ONE bulk cache read. The old
  // per-row readCache was an N+1 that would have pushed a 10K job's
  // pre-submit phase past the function ceiling on its own.
  const normalizedById = new Map<string, string>();
  for (const propertyId of params.propertyIds) {
    const p = propsById.get(propertyId);
    if (!p) continue;
    normalizedById.set(
      propertyId,
      normalizeAddress({
        address: p.address,
        city: p.city,
        state: p.state,
        zip: p.zip,
      }),
    );
  }
  const cacheByAddress = await readCacheMany(
    supabase,
    provider.providerId,
    Array.from(normalizedById.values()),
  );

  for (const propertyId of params.propertyIds) {
    const p = propsById.get(propertyId);
    if (!p) {
      summary.failed++;
      try {
        await insertJobItem(supabase, params.jobId, propertyId, {
          status: "error",
          error_class: "database",
          error_message: "Property not found",
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "skip_trace_property_not_found_item" },
          extra: { jobId: params.jobId, propertyId },
        });
      }
      continue;
    }
    const addressNormalized = normalizedById.get(propertyId) as string;
    const cached = cacheByAddress.get(addressNormalized) ?? null;
    if (cached) {
      // Cache row stores the previous result; reuse it but rewrite the
      // propertyId so persistence targets the *current* row.
      cachedResults.push({ ...cached.result, propertyId });
      summary.cached_hits++;
    } else {
      const mailing = p.homeowner_contact_id
        ? mailingByContact.get(p.homeowner_contact_id)
        : null;
      misses.push({
        propertyId,
        address: p.address,
        city: p.city ?? "",
        state: p.state,
        zip: p.zip ?? null,
        mailingAddress: mailing?.mailing_address ?? null,
        mailingCity: mailing?.mailing_city ?? null,
        mailingState: mailing?.mailing_state ?? null,
        mailingZip: mailing?.mailing_zip ?? null,
      });
    }
  }

  // ------------------------------------------------------------------
  // 2. Persist cached hits first (fast, no API calls).
  // ------------------------------------------------------------------
  for (const result of cachedResults) {
    await persistAndRecord(supabase, params.jobId, result, summary, /*fromCache*/ true);
  }

  // ------------------------------------------------------------------
  // 3. Decide path for misses: 0 / 1-sync / N-async
  // ------------------------------------------------------------------
  if (misses.length === 0) {
    await finalizeJob(supabase, params.jobId, summary);
    return summary;
  }

  if (misses.length === 1) {
    try {
      const result = await provider.lookupSingle(misses[0]);
      await persistAndRecord(supabase, params.jobId, result, summary, /*fromCache*/ false);
      await writeCache(
        supabase,
        provider.providerId,
        normalizeAddress({
          address: misses[0].address,
          city: misses[0].city,
          state: misses[0].state,
          zip: misses[0].zip,
        }),
        result,
      );
    } catch (e) {
      summary.failed++;
      const msg = e instanceof Error ? e.message : String(e);
      const klass: "provider_transient" | "provider_unknown" | "database" =
        e instanceof ProviderError ? classifyProviderError(e) : "database";
      reportError(e, {
        tags: { surface: "skip_trace_lookup_single" },
        extra: { propertyId: misses[0].propertyId, jobId: params.jobId },
      });
      try {
        await insertJobItem(supabase, params.jobId, misses[0].propertyId, {
          status: "error",
          error_class: klass,
          error_message: msg,
        });
      } catch (insertErr) {
        reportError(insertErr, {
          tags: { surface: "skip_trace_lookup_single_item" },
          extra: { jobId: params.jobId, propertyId: misses[0].propertyId },
        });
      }
    }
    await finalizeJob(supabase, params.jobId, summary);
    return summary;
  }

  // misses.length >= 2 → async batch.
  //
  // Tracerfy silently dedupes batches by address ("Cleans and
  // de-duplicates rows, then enqueues processing"), and the result
  // shape doesn't reliably round-trip our `external_id`. So before
  // submitting, group misses by a normalized address key, send one
  // input per unique address, and persist the
  // `addressKey -> propertyIds[]` map onto the job. `finalize` reads
  // it back to fan each result row out to every property at that
  // address — covering both Tracerfy's dedup AND the legitimate case
  // where two of our properties share the same physical address.
  const addressToPropertyIds = new Map<string, string[]>();
  const uniqueByAddress: SkipTraceInput[] = [];
  for (const miss of misses) {
    const key = normalizeAddressForMatch({
      address: miss.address,
      city: miss.city,
      state: miss.state,
    });
    const existing = addressToPropertyIds.get(key);
    if (existing) {
      existing.push(miss.propertyId);
    } else {
      addressToPropertyIds.set(key, [miss.propertyId]);
      uniqueByAddress.push(miss);
    }
  }
  const mapAsObject: Record<string, string[]> = {};
  for (const [key, ids] of addressToPropertyIds) {
    mapAsObject[key] = ids;
  }

  try {
    const ticket = await provider.submitBatch(uniqueByAddress);
    await supabase
      .from("jobs")
      .update({
        provider_run_id: ticket.queueId,
        worker_heartbeat_at: new Date().toISOString(),
        result_summary: {
          ...summary,
          batch_pending: true,
          estimated_wait_seconds: ticket.estimatedWaitSeconds,
          credits_per_lead: ticket.creditsPerLead,
          // The fan-out ledger. Keyed by `address|city|state` (lower).
          address_to_property_ids: mapAsObject,
          unique_addresses_submitted: uniqueByAddress.length,
        } as unknown as Json,
      })
      .eq("id", params.jobId);
    return { pending: true, queueId: ticket.queueId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markJobFailed(supabase, params.jobId, `submitBatch failed: ${msg}`);
    reportError(e, {
      tags: { surface: "skip_trace_submit_batch" },
      extra: { jobId: params.jobId, count: uniqueByAddress.length },
    });
    return summary;
  }
}

/**
 * Finalize a job whose batch results just arrived (via webhook or
 * polling). Iterates each result, persists, writes cache, updates job
 * progress, transitions to terminal status, dispatches notification.
 *
 * Match strategy:
 *   1. If `result_summary.address_to_property_ids` was set at submit
 *      time, match each result row by `matchedAddress` and fan it out
 *      to every property in that bucket. This is the production path
 *      for Tracerfy batches — necessary because Tracerfy dedupes
 *      input by address and doesn't reliably round-trip external_id.
 *   2. Fall back to `result.propertyId` matching when no map is
 *      present (cached hits, sync flows, legacy jobs).
 *
 * After applying results, any property whose submitted address never
 * came back gets a per-property error item so the UI surfaces the
 * gap (rather than the job sitting at "completed" with mysterious
 * count gaps).
 */
export async function finalizeSkipTraceFromBatch(
  supabase: SupabaseClient<Database>,
  params: { jobId: string; results: SkipTraceResult[] },
): Promise<SkipTraceJobSummary | null> {
  // ------------------------------------------------------------------
  // Atomic claim. Finalize at 4K rows takes minutes while the sweep
  // cron fires every minute AND the webhook can land concurrently — on
  // 2026-06-12 four overlapping finalizers wrote 16,000 job_items on a
  // 4,000-row job. The UPDATE's `status='running'` predicate makes the
  // claim atomic: exactly one caller flips running→finalizing; everyone
  // else sees zero rows updated and walks away.
  // ------------------------------------------------------------------
  const { data: claimed, error: claimErr } = await supabase
    .from("jobs")
    .update({
      status: "finalizing",
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", params.jobId)
    .eq("status", "running")
    .select("result_summary");
  if (claimErr) {
    throw new Error(`finalize claim failed: ${claimErr.message}`);
  }
  if (!claimed || claimed.length === 0) {
    // Another finalizer owns (or already finished) this job.
    return null;
  }
  const jobRow = claimed[0];

  try {
    return await finalizeClaimed(supabase, params, jobRow.result_summary);
  } catch (e) {
    // Give the job back so the next sweep tick can re-claim and retry —
    // a crashed finalizer must not strand the job in 'finalizing'.
    await supabase
      .from("jobs")
      .update({ status: "running" })
      .eq("id", params.jobId)
      .eq("status", "finalizing");
    throw e;
  }
}

async function finalizeClaimed(
  supabase: SupabaseClient<Database>,
  params: { jobId: string; results: SkipTraceResult[] },
  priorSummary: unknown,
): Promise<SkipTraceJobSummary> {
  const prior = (priorSummary ?? {}) as Partial<SkipTraceJobSummary> & {
    batch_pending?: boolean;
    address_to_property_ids?: Record<string, string[]>;
  };

  const addressMap: Record<string, string[]> | null =
    prior.address_to_property_ids && typeof prior.address_to_property_ids === "object"
      ? prior.address_to_property_ids
      : null;

  // Total stays at "what we submitted" — the map's distinct property
  // count if available, otherwise prior.total or the result count as a
  // last-ditch fallback. Resist using `params.results.length` directly
  // because Tracerfy may collapse N inputs into <N rows.
  const totalFromMap = addressMap
    ? Object.values(addressMap).reduce((n, arr) => n + arr.length, 0)
    : null;

  const summary: SkipTraceJobSummary = {
    total: prior.total ?? totalFromMap ?? params.results.length,
    matched: prior.matched ?? 0,
    no_match: prior.no_match ?? 0,
    failed: prior.failed ?? 0,
    cached_hits: prior.cached_hits ?? 0,
    api_hits: prior.api_hits ?? 0,
    total_credits: prior.total_credits ?? 0,
  };

  // Resolve provider once for cache writes.
  const provider = getSkipTraceProvider();
  const providerId = provider?.providerId ?? "tracerfy";

  // ------------------------------------------------------------------
  // Build the fan-out plan. For each result row:
  //   - figure out which propertyIds it applies to
  //   - track which mapped propertyIds we satisfied so we can write
  //     error items for the unsatisfied remainder afterwards
  // ------------------------------------------------------------------
  const satisfiedPropertyIds = new Set<string>();
  const fanOut: Array<{ propertyId: string; result: SkipTraceResult }> = [];
  const unmatchedResults: SkipTraceResult[] = [];

  for (const result of params.results) {
    let bucket: string[] | null = null;
    if (addressMap) {
      const m = result.matchedAddress;
      const key = m
        ? normalizeAddressForMatch({
            address: m.address,
            city: m.city,
            state: m.state,
          })
        : null;
      if (key && addressMap[key]) {
        bucket = addressMap[key];
      } else if (result.propertyId) {
        // Compat: row didn't echo an address (older webhook payloads,
        // hand-built test fixtures), but its propertyId IS in one of
        // our submitted buckets. Trust the propertyId in that case.
        for (const ids of Object.values(addressMap)) {
          if (ids.includes(result.propertyId)) {
            bucket = [result.propertyId];
            break;
          }
        }
      }
    } else if (result.propertyId) {
      // No map at all → legacy / sync / cache path. propertyId is
      // authoritative.
      bucket = [result.propertyId];
    }

    if (!bucket || bucket.length === 0) {
      unmatchedResults.push(result);
      continue;
    }

    for (const propertyId of bucket) {
      satisfiedPropertyIds.add(propertyId);
      fanOut.push({
        propertyId,
        result: { ...result, propertyId },
      });
    }
  }

  // Property addresses are needed both for cache writes and for error
  // items on missing-from-batch properties. One query covers all.
  const allRelatedPropertyIds = new Set<string>();
  for (const { propertyId } of fanOut) allRelatedPropertyIds.add(propertyId);
  if (addressMap) {
    for (const ids of Object.values(addressMap)) {
      for (const id of ids) allRelatedPropertyIds.add(id);
    }
  }
  // Chunked — a 4,000-id .in() rides the URL past PostgREST's request
  // line limit and the query fails wholesale (which then misclassified
  // every missing property as address_unverified on 2026-06-12).
  const props: Array<{
    id: string;
    address: string;
    city: string | null;
    state: string;
    zip: string | null;
    cass_status: string;
  }> = [];
  for (const ids of chunked(Array.from(allRelatedPropertyIds), IN_CHUNK)) {
    const { data, error } = await supabase
      .from("properties")
      .select("id, address, city, state, zip, cass_status")
      .in("id", ids);
    if (error) {
      reportError(error, {
        tags: { surface: "skip_trace_finalize_props_lookup" },
        extra: { jobId: params.jobId, chunkSize: ids.length },
      });
    }
    if (data) props.push(...data);
  }
  const propsById = new Map(props.map((p) => [p.id, p]));

  // Refresh the claim heartbeat as the long loops below grind through
  // thousands of rows, so the sweep's stale-finalizing rescue (15 min)
  // can tell "working" from "crashed".
  let heartbeatCounter = 0;
  const bumpHeartbeat = async () => {
    heartbeatCounter++;
    if (heartbeatCounter % 500 !== 0) return;
    await supabase
      .from("jobs")
      .update({ worker_heartbeat_at: new Date().toISOString() })
      .eq("id", params.jobId);
  };

  // ------------------------------------------------------------------
  // Apply results. Wrap each persist in try/catch so one bad row can't
  // break the rest of the batch.
  // ------------------------------------------------------------------
  for (const { propertyId, result } of fanOut) {
    await bumpHeartbeat();
    try {
      await persistAndRecord(
        supabase,
        params.jobId,
        result,
        summary,
        /*fromCache*/ false,
      );
    } catch (e) {
      // persistAndRecord already swallows persist-time errors into
      // job_items + summary. This catches anything insertJobItem itself
      // throws (e.g. transient DB error). Log + keep going.
      reportError(e, {
        tags: { surface: "skip_trace_finalize_per_row" },
        extra: { jobId: params.jobId, propertyId },
      });
    }

    const p = propsById.get(propertyId);
    if (p) {
      try {
        await writeCache(
          supabase,
          providerId,
          normalizeAddress({
            address: p.address,
            city: p.city,
            state: p.state,
            zip: p.zip,
          }),
          result,
        );
      } catch (e) {
        // Cache failure is non-fatal — log and continue.
        reportError(e, {
          tags: { surface: "skip_trace_finalize_cache_write" },
          extra: { jobId: params.jobId, propertyId },
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // Properties that were submitted but never came back: write an
  // error item per property so the UI doesn't go silent on the gap.
  // ------------------------------------------------------------------
  if (addressMap) {
    const missing: string[] = [];
    for (const ids of Object.values(addressMap)) {
      for (const id of ids) {
        if (!satisfiedPropertyIds.has(id)) missing.push(id);
      }
    }
    for (const propertyId of missing) {
      await bumpHeartbeat();
      summary.failed++;
      const p = propsById.get(propertyId);
      const isCassVerified = p?.cass_status === "verified";

      // Verified address + no provider row = "vendor genuinely empty"
      // (terminal). Unverified address = upstream block, can't tell if
      // the vendor would have data once normalized.
      const klass: "provider_no_data" | "address_unverified" = isCassVerified
        ? "provider_no_data"
        : "address_unverified";
      const errorMessage = isCassVerified
        ? "Provider has no owner data for this address."
        : "Address not USPS-verified (CASS); cannot reliably look up. Verify the address first.";

      try {
        await insertJobItem(supabase, params.jobId, propertyId, {
          status: "error",
          error_class: klass,
          error_message: errorMessage,
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "skip_trace_finalize_missing_item" },
          extra: { jobId: params.jobId, propertyId },
        });
      }

      // Cache the "no data" verdict for verified addresses so future
      // runs hit cache instead of re-paying the vendor. Skip
      // unverified — their normalized address will change once CASS
      // runs, so the cache key would be stale anyway.
      if (isCassVerified && p) {
        try {
          await writeCache(
            supabase,
            providerId,
            normalizeAddress({
              address: p.address,
              city: p.city,
              state: p.state,
              zip: p.zip,
            }),
            emptyNoMatchResult(propertyId),
          );
        } catch (e) {
          reportError(e, {
            tags: { surface: "skip_trace_finalize_cache_no_match" },
            extra: { jobId: params.jobId, propertyId },
          });
        }
      }
    }
  }

  // Result rows whose address didn't match any submitted bucket: log
  // them so we don't lose visibility, but don't fail the job — these
  // are provider-side bugs (rare) and we have no property to attach
  // them to.
  if (unmatchedResults.length > 0) {
    reportError(new Error("Skip-trace batch returned unmatched result rows"), {
      tags: { surface: "skip_trace_finalize_unmatched" },
      extra: {
        jobId: params.jobId,
        count: unmatchedResults.length,
        sample: unmatchedResults.slice(0, 3).map((r) => r.matchedAddress),
      },
    });
  }

  await finalizeJob(supabase, params.jobId, summary);
  return summary;
}

// ---------- helpers ----------------------------------------------------

async function persistAndRecord(
  supabase: SupabaseClient<Database>,
  jobId: string,
  result: SkipTraceResult,
  summary: SkipTraceJobSummary,
  fromCache: boolean,
): Promise<void> {
  // Local helper so a transient DB hiccup writing one job_item row
  // doesn't kill the whole loop. We still update `summary` first so
  // counts stay consistent with what the user expects to see — the
  // missing audit row is a known degradation we accept and log.
  const tryInsert = async (
    fields: Parameters<typeof insertJobItem>[3],
  ): Promise<void> => {
    try {
      await insertJobItem(supabase, jobId, result.propertyId, fields);
    } catch (e) {
      reportError(e, {
        tags: { surface: "skip_trace_persist_record_insert" },
        extra: { jobId, propertyId: result.propertyId, status: fields.status },
      });
    }
  };

  let outcome: PersistOutcome;
  try {
    outcome = await persistSkipTraceResult(supabase, result);
  } catch (e) {
    summary.failed++;
    const msg = e instanceof Error ? e.message : String(e);
    reportError(e, {
      tags: { surface: "skip_trace_persist" },
      extra: { jobId, propertyId: result.propertyId },
    });
    await tryInsert({
      status: "error",
      error_class: "database",
      error_message: msg,
    });
    return;
  }

  if (!fromCache) summary.api_hits++;
  summary.total_credits += result.creditsDeducted;

  if (outcome.status === "matched") {
    summary.matched++;
    await tryInsert({
      status: "success",
      result: {
        from_cache: fromCache,
        credits_deducted: result.creditsDeducted,
        phones_added: outcome.phonesAdded,
        emails_added: outcome.emailsAdded,
      },
    });
  } else if (outcome.status === "no_match") {
    summary.no_match++;
    await tryInsert({
      status: "success",
      result: {
        from_cache: fromCache,
        credits_deducted: result.creditsDeducted,
        no_match: true,
      },
    });
  } else {
    summary.failed++;
    await tryInsert({
      status: "error",
      error_class: "database",
      error_message: "Property not found at persist time",
    });
  }
}

/**
 * Classify a ProviderError into a retryability bucket. HTTP 429 + 5xx
 * are transient (retry will likely succeed once the vendor recovers);
 * everything else lands in `provider_unknown` (still retryable but
 * worth a second look).
 */
function classifyProviderError(
  err: ProviderError,
): "provider_transient" | "provider_unknown" {
  const status =
    typeof err.details?.status === "number" ? err.details.status : null;
  if (status === 429) return "provider_transient";
  if (status !== null && status >= 500 && status < 600) return "provider_transient";
  return "provider_unknown";
}

/**
 * Build the empty SkipTraceResult written to cache for an address whose
 * provider lookup confirmed "no data." Stored so subsequent skip-trace
 * runs hit cache and avoid re-paying the vendor for the same null
 * answer. Only called for CASS-verified addresses — caching a negative
 * for an unverified address would go stale once CASS normalization
 * changes the cache key.
 */
function emptyNoMatchResult(propertyId: string): SkipTraceResult {
  return {
    propertyId,
    hit: false,
    persons: [],
    creditsDeducted: 0,
    raw: { provider_no_data: true },
  };
}

/**
 * Insert a row into `job_items` for a single property's outcome.
 *
 * Throws on Supabase errors so callers can surface (and the
 * call-site try/catch can swallow per-row failures without taking
 * down the whole batch). Pre-PR this swallowed errors silently,
 * which masked a real bug where 21 properties had no items at all.
 */
async function insertJobItem(
  supabase: SupabaseClient<Database>,
  jobId: string,
  propertyId: string,
  fields: {
    status: "success" | "error" | "skipped";
    error_class?:
      | "database"
      | "provider"
      | "provider_no_data"
      | "address_unverified"
      | "provider_transient"
      | "provider_unknown"
      | "configuration"
      | "validation"
      | "transient"
      | "authorization";
    error_message?: string;
    result?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase.from("job_items").insert({
    job_id: jobId,
    property_id: propertyId,
    status: fields.status,
    error_class: fields.error_class ?? null,
    error_message: fields.error_message ?? null,
    output_payload: (fields.result ?? null) as unknown as Json,
  });
  if (error) {
    reportError(error, {
      tags: { surface: "skip_trace_insert_job_item" },
      extra: { jobId, propertyId, status: fields.status },
    });
    throw new Error(`insert job_item failed: ${error.message}`);
  }
}

async function finalizeJob(
  supabase: SupabaseClient<Database>,
  jobId: string,
  summary: SkipTraceJobSummary,
): Promise<void> {
  const status: Database["public"]["Tables"]["jobs"]["Update"]["status"] =
    summary.failed === 0
      ? "completed"
      : summary.matched + summary.no_match === 0
        ? "failed"
        : "partial";

  await supabase
    .from("jobs")
    .update({
      status,
      processed_items: summary.total,
      succeeded_items: summary.matched + summary.no_match,
      failed_items: summary.failed,
      completed_at: new Date().toISOString(),
      result_summary: summary as unknown as Json,
    })
    .eq("id", jobId);

  try {
    await dispatchJobCompleted(supabase, { jobId });
  } catch (e) {
    reportError(e, {
      tags: { surface: "skip_trace_job_notification_dispatch" },
      extra: { jobId },
    });
  }
}

async function markJobCanceled(
  supabase: SupabaseClient<Database>,
  jobId: string,
  reason: string,
): Promise<void> {
  await supabase
    .from("jobs")
    .update({
      status: "canceled",
      completed_at: new Date().toISOString(),
      error_message: reason,
    })
    .eq("id", jobId);
}

async function markJobFailed(
  supabase: SupabaseClient<Database>,
  jobId: string,
  reason: string,
): Promise<void> {
  await supabase
    .from("jobs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: reason,
    })
    .eq("id", jobId);
}
