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
import {
  buildSkipTraceEligibilityAudit,
  mergeSkipTraceEligibilityAudits,
  resolveSkipTraceEligibility,
  skipTraceAudienceDescription,
  skipTraceAudienceTitle,
  type SkipTraceEligibilityAudit,
} from "./eligibility";
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
  dnc_skipped?: number;
  dnc_contact_ambiguous?: number;
  eligibility_exclusions?: Json;
};

function jsonRecord(value: Json | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json | undefined>)
    : {};
}

type RefreshedAudience = {
  claimed: boolean;
  checkedEligibleIds: string[];
  audienceIds: string[];
  audit: SkipTraceEligibilityAudit;
};

async function heartbeatOwnedAttempt(
  supabase: SupabaseClient<Database>,
  params: { jobId: string; orgId: string; attemptToken: string },
): Promise<boolean> {
  const { data, error } = await supabase
    .from("jobs")
    .update({ worker_heartbeat_at: new Date().toISOString() })
    .eq("id", params.jobId)
    .eq("org_id", params.orgId)
    .eq("type", "skip_trace")
    .eq("status", "running")
    .contains("input_params", {
      submission_attempt_token: params.attemptToken,
    })
    .is("provider_run_id", null)
    .select("id");
  if (error) {
    throw new Error(
      `skip-trace ownership heartbeat failed for ${params.jobId}: ${error.message}`,
    );
  }
  return !!data && data.length === 1;
}

async function refreshSkipTraceAudience(
  supabase: SupabaseClient<Database>,
  params: {
    jobId: string;
    orgId: string;
    propertyIdsToCheck: string[];
    survivingIdsOutsideCheck: string[];
    inputParams?: Json;
    priorAudit?: Json;
    summary: SkipTraceJobSummary;
    attemptToken: string;
    originalTitle: string | null;
    originalDescription: string | null;
  },
): Promise<RefreshedAudience> {
  const idsToCheck = [...new Set(params.propertyIdsToCheck)];
  const eligibility = await resolveSkipTraceEligibility(supabase, {
    orgId: params.orgId,
    propertyIds: idsToCheck,
  });
  const audit = mergeSkipTraceEligibilityAudits(
    params.priorAudit,
    buildSkipTraceEligibilityAudit(eligibility, idsToCheck.length),
  );
  const audienceIds = [
    ...new Set([
      ...params.survivingIdsOutsideCheck,
      ...eligibility.eligibleIds,
    ]),
  ];
  audit.eligible = audienceIds.length;
  const nextSummary = {
    ...params.summary,
    total: audienceIds.length,
    eligibility_exclusions: audit as unknown as Json,
    submit_phase: "prepared",
    submit_phase_prepared_at: new Date().toISOString(),
  } as unknown as Json;
  const nextInputParams = {
    ...jsonRecord(params.inputParams),
    property_ids: audienceIds,
    eligibility_exclusions: audit,
  } as unknown as Json;
  const { data, error } = await supabase
    .from("jobs")
    .update({
      total_items: audienceIds.length,
      title: skipTraceAudienceTitle(
        params.originalTitle,
        audienceIds.length,
        audit.total,
      ),
      description: skipTraceAudienceDescription(
        params.originalDescription,
        audienceIds.length,
        audit.total,
      ),
      input_params: nextInputParams,
      result_summary: nextSummary,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", params.jobId)
    .eq("org_id", params.orgId)
    .eq("type", "skip_trace")
    .eq("status", "running")
    .contains("input_params", {
      submission_attempt_token: params.attemptToken,
    })
    .is("provider_run_id", null)
    .select("id");
  if (error) {
    throw new Error(
      `skip-trace audience checkpoint failed for ${params.jobId}: ${error.message}`,
    );
  }
  return {
    claimed: !!data && data.length > 0,
    checkedEligibleIds: eligibility.eligibleIds,
    audienceIds,
    audit,
  };
}

async function checkpointProviderSubmission(
  supabase: SupabaseClient<Database>,
  params: {
    jobId: string;
    orgId: string;
    attemptToken: string;
    summary: Json;
  },
): Promise<void> {
  const { data, error } = await supabase
    .from("jobs")
    .update({
      result_summary: params.summary,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", params.jobId)
    .eq("org_id", params.orgId)
    .eq("type", "skip_trace")
    .eq("status", "running")
    .contains("input_params", { submission_attempt_token: params.attemptToken })
    .is("provider_run_id", null)
    .select("id");
  if (error || !data || data.length === 0) {
    throw new Error(
      `skip-trace provider-boundary checkpoint failed for ${params.jobId}: ${error?.message ?? "claim lost"}`,
    );
  }
}

async function cancelEmptyAudience(
  supabase: SupabaseClient<Database>,
  params: {
    jobId: string;
    orgId: string;
    inputParams?: Json;
    attemptToken: string;
    originalTitle: string | null;
    originalDescription: string | null;
  },
  summary: SkipTraceJobSummary,
  audit: SkipTraceEligibilityAudit,
): Promise<void> {
  const completedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("jobs")
    .update({
      status: "canceled",
      total_items: 0,
      title: skipTraceAudienceTitle(params.originalTitle, 0, audit.total),
      description: skipTraceAudienceDescription(
        params.originalDescription,
        0,
        audit.total,
      ),
      input_params: {
        ...jsonRecord(params.inputParams),
        property_ids: [],
        eligibility_exclusions: audit,
      } as unknown as Json,
      result_summary: {
        ...summary,
        total: 0,
        eligibility_exclusions: audit,
        submit_phase: "canceled_before_provider",
      } as unknown as Json,
      completed_at: completedAt,
      worker_heartbeat_at: completedAt,
    })
    .eq("id", params.jobId)
    .eq("org_id", params.orgId)
    .eq("type", "skip_trace")
    .eq("status", "running")
    .contains("input_params", {
      submission_attempt_token: params.attemptToken,
    })
    .is("provider_run_id", null)
    .select("id");
  if (error) {
    throw new Error(
      `skip-trace empty-audience cancellation failed for ${params.jobId}: ${error.message}`,
    );
  }
  if (!data || data.length === 0) {
    throw new Error(
      `skip-trace empty-audience cancellation lost claim for ${params.jobId}`,
    );
  }
}

export async function runSkipTraceEnrichment(
  supabase: SupabaseClient<Database>,
  params: {
    jobId: string;
    orgId: string;
    propertyIds: string[];
    inputParams?: Json;
    eligibilityExclusions?: Json;
    expectedHeartbeat?: string | null;
    /** Deterministic test seam; the authoritative eligibility read follows it. */
    beforeProviderEligibilityCheck?: () => Promise<void>;
    /** Deterministic batch test seam; the final provider eligibility read follows it. */
    beforeBatchProviderEligibilityCheck?: () => Promise<void>;
    /** Failure-injection seams for the paid single-result durability boundary. */
    beforeSingleLedgerWrite?: (propertyId: string) => Promise<void>;
    beforeSingleCacheWrite?: () => Promise<void>;
  },
): Promise<
  SkipTraceJobSummary | { pending: true; queueId: string } | { claimed: false }
> {
  const propertyIds = [...new Set(params.propertyIds)];
  const summary: SkipTraceJobSummary = {
    total: propertyIds.length,
    matched: 0,
    no_match: 0,
    failed: 0,
    cached_hits: 0,
    api_hits: 0,
    total_credits: 0,
    ...(params.eligibilityExclusions
      ? { eligibility_exclusions: params.eligibilityExclusions }
      : {}),
  };

  const attemptToken = crypto.randomUUID();
  const claimedInputParams = {
    ...jsonRecord(params.inputParams),
    property_ids: propertyIds,
    submission_attempt_token: attemptToken,
  } as unknown as Json;
  const claimTime = new Date().toISOString();
  let claim = supabase
    .from("jobs")
    .update({
      status: "running",
      started_at: claimTime,
      total_items: propertyIds.length,
      input_params: claimedInputParams,
      worker_heartbeat_at: claimTime,
    })
    .eq("id", params.jobId)
    .eq("org_id", params.orgId)
    .eq("type", "skip_trace")
    .eq("status", "queued")
    .eq("total_items", propertyIds.length)
    .contains("input_params", {
      property_ids: propertyIds,
    })
    .is("provider_run_id", null);
  claim = params.expectedHeartbeat
    ? claim.eq("worker_heartbeat_at", params.expectedHeartbeat)
    : claim.is("worker_heartbeat_at", null);
  const { data: claimedJobs, error: claimError } = await claim.select(
    "id, title, description",
  );
  if (claimError) {
    reportError(claimError, {
      tags: { surface: "skip_trace_runner_claim" },
      extra: { jobId: params.jobId, orgId: params.orgId },
    });
    return { claimed: false };
  }
  const claimedJob = claimedJobs?.[0];
  if (!claimedJob) return { claimed: false };
  const originalTitle = claimedJob.title;
  const originalDescription = claimedJob.description;
  const ownedParams = {
    ...params,
    inputParams: claimedInputParams,
    attemptToken,
    originalTitle,
    originalDescription,
  };

  // ------------------------------------------------------------------
  // 0. Resolve provider
  // ------------------------------------------------------------------
  let provider;
  try {
    provider = getSkipTraceProvider();
  } catch (e) {
    if (e instanceof ConfigurationError) {
      await markJobCanceled(
        supabase,
        params.jobId,
        e.message,
        params.orgId,
        attemptToken,
      );
      return summary;
    }
    throw e;
  }
  if (!provider) {
    await markJobCanceled(
      supabase,
      params.jobId,
      "Skip-trace provider disabled",
      params.orgId,
      attemptToken,
    );
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
    skip_trace_disabled: boolean;
  }> = [];
  for (const ids of chunked(propertyIds, IN_CHUNK)) {
    const { data } = await supabase
      .from("properties")
      .select(
        "id, address, city, state, zip, homeowner_contact_id, cass_status, skip_trace_disabled",
      )
      .eq("org_id", params.orgId)
      .in("id", ids);
    if (data) properties.push(...data);
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
      .eq("org_id", params.orgId)
      .in("contact_id", ids);
    if (data) homeowners.push(...data);
  }

  const mailingByContact = new Map(homeowners.map((h) => [h.contact_id, h]));

  let cachedResults: SkipTraceResult[] = [];
  let misses: SkipTraceInput[] = [];
  const propsById = new Map(properties.map((p) => [p.id, p]));

  // Pass 1: normalize every address, then ONE bulk cache read. The old
  // per-row readCache was an N+1 that would have pushed a 10K job's
  // pre-submit phase past the function ceiling on its own.
  const normalizedById = new Map<string, string>();
  for (const propertyId of propertyIds) {
    const p = propsById.get(propertyId);
    if (!p) continue;
    if (p.skip_trace_disabled || p.cass_status !== "verified") continue;
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
    params.orgId,
    provider.providerId,
    Array.from(normalizedById.values()),
  );

  for (const propertyId of propertyIds) {
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
    if (p.skip_trace_disabled) {
      summary.failed++;
      try {
        await insertJobItem(supabase, params.jobId, propertyId, {
          status: "error",
          error_class: "validation",
          error_message: "Skip trace is disabled for this property.",
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "skip_trace_disabled_item" },
          extra: { jobId: params.jobId, propertyId },
        });
      }
      continue;
    }
    if (p.cass_status !== "verified") {
      summary.failed++;
      try {
        await insertJobItem(supabase, params.jobId, propertyId, {
          status: "error",
          error_class: "address_unverified",
          error_message:
            "Address not USPS-verified (CASS); verify the address before skip tracing.",
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "skip_trace_unverified_item" },
          extra: { jobId: params.jobId, propertyId },
        });
      }
      continue;
    }
    const addressNormalized = normalizedById.get(propertyId);
    if (!addressNormalized) continue;
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

  // The workflow checked before claiming, but property/cache preparation can
  // take long enough for a homeowner to opt out. Recheck after that work and
  // before cached persistence or any paid provider branch.
  let audience = await refreshSkipTraceAudience(supabase, {
    jobId: params.jobId,
    orgId: params.orgId,
    propertyIdsToCheck: propertyIds,
    survivingIdsOutsideCheck: [],
    inputParams: claimedInputParams,
    priorAudit: params.eligibilityExclusions,
    summary,
    attemptToken,
    originalTitle,
    originalDescription,
  });
  if (!audience.claimed) return summary;
  const preparedEligible = new Set(audience.checkedEligibleIds);
  cachedResults = cachedResults.filter((result) =>
    preparedEligible.has(result.propertyId),
  );
  misses = misses.filter((miss) => preparedEligible.has(miss.propertyId));
  summary.cached_hits = cachedResults.length;
  summary.total = audience.audienceIds.length;
  summary.eligibility_exclusions = audience.audit as unknown as Json;
  if (audience.audienceIds.length === 0) {
    await cancelEmptyAudience(supabase, ownedParams, summary, audience.audit);
    return summary;
  }

  // ------------------------------------------------------------------
  // 2. Persist cached hits first (fast, no API calls).
  // ------------------------------------------------------------------
  for (const result of cachedResults) {
    await persistAndRecord(
      supabase,
      params.orgId,
      params.jobId,
      result,
      summary,
      /*fromCache*/ true,
    );
  }

  // ------------------------------------------------------------------
  // 3. Decide path for misses: 0 / 1-sync / N-async
  // ------------------------------------------------------------------
  if (misses.length === 0) {
    await finalizeJob(supabase, params.jobId, summary, {
      orgId: params.orgId,
      attemptToken,
    });
    return summary;
  }

  // Cached persistence can also be a long loop. Recheck only the records that
  // are still provider-bound, then cross the paid boundary immediately.
  audience = await refreshSkipTraceAudience(supabase, {
    jobId: params.jobId,
    orgId: params.orgId,
    propertyIdsToCheck: misses.map((miss) => miss.propertyId),
    survivingIdsOutsideCheck: cachedResults.map((result) => result.propertyId),
    inputParams: claimedInputParams,
    priorAudit: audience.audit as unknown as Json,
    summary,
    attemptToken,
    originalTitle,
    originalDescription,
  });
  if (!audience.claimed) return summary;
  const providerEligible = new Set(audience.checkedEligibleIds);
  misses = misses.filter((miss) => providerEligible.has(miss.propertyId));
  summary.total = audience.audienceIds.length;
  summary.eligibility_exclusions = audience.audit as unknown as Json;
  if (misses.length === 0) {
    if (cachedResults.length === 0) {
      await cancelEmptyAudience(supabase, ownedParams, summary, audience.audit);
    } else {
      await finalizeJob(supabase, params.jobId, summary, {
        orgId: params.orgId,
        attemptToken,
      });
    }
    return summary;
  }

  const reconcileProviderExclusions = async (): Promise<
    "continue" | "stop"
  > => {
    audience = await refreshSkipTraceAudience(supabase, {
      jobId: params.jobId,
      orgId: params.orgId,
      propertyIdsToCheck: misses.map((miss) => miss.propertyId),
      survivingIdsOutsideCheck: cachedResults.map(
        (result) => result.propertyId,
      ),
      inputParams: claimedInputParams,
      priorAudit: audience.audit as unknown as Json,
      summary,
      attemptToken,
      originalTitle,
      originalDescription,
    });
    if (!audience.claimed) return "stop";
    const eligible = new Set(audience.checkedEligibleIds);
    misses = misses.filter((miss) => eligible.has(miss.propertyId));
    summary.total = audience.audienceIds.length;
    summary.eligibility_exclusions = audience.audit as unknown as Json;
    if (misses.length > 0) return "continue";
    if (cachedResults.length === 0) {
      await cancelEmptyAudience(supabase, ownedParams, summary, audience.audit);
    } else {
      await finalizeJob(supabase, params.jobId, summary, {
        orgId: params.orgId,
        attemptToken,
      });
    }
    return "stop";
  };

  // A compliance state can change while the checkpoint write above is in
  // flight. Resolve once more as the last application-level operation before
  // each provider invocation. If anything changed, checkpoint the smaller
  // audience and repeat until the remaining set is stable.
  try {
    await params.beforeProviderEligibilityCheck?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markJobFailed(
      supabase,
      params.jobId,
      `Provider eligibility checkpoint failed: ${message}`,
      params.orgId,
      attemptToken,
    );
    return summary;
  }
  let batchHookCompleted = false;
  providerSubmission: while (true) {
    const boundaryEligibility = await resolveSkipTraceEligibility(supabase, {
      orgId: params.orgId,
      propertyIds: misses.map((miss) => miss.propertyId),
    });
    if (boundaryEligibility.exclusions.length > 0) {
      if ((await reconcileProviderExclusions()) === "stop") return summary;
      continue;
    }

    if (misses.length === 1) {
      if (
        !(await heartbeatOwnedAttempt(supabase, {
          jobId: params.jobId,
          orgId: params.orgId,
          attemptToken,
        }))
      ) {
        return summary;
      }
      const submissionSummary = {
        ...summary,
        submit_phase: "submitting",
        submit_phase_started_at: new Date().toISOString(),
      } as unknown as Json;
      await checkpointProviderSubmission(supabase, {
        jobId: params.jobId,
        orgId: params.orgId,
        attemptToken,
        summary: submissionSummary,
      });
      let providerCallStarted = false;
      try {
        providerCallStarted = true;
        const result = await provider.lookupSingle(misses[0]);
        await persistAndRecord(
          supabase,
          params.orgId,
          params.jobId,
          result,
          summary,
          /*fromCache*/ false,
          {
            requireLedgerWrite: true,
            beforeLedgerWrite: params.beforeSingleLedgerWrite,
          },
        );
        await params.beforeSingleCacheWrite?.();
        await writeCache(
          supabase,
          params.orgId,
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
        const msg = e instanceof Error ? e.message : String(e);
        if (providerCallStarted && isSubmissionUnknownError(e)) {
          await safelyMarkSubmissionUnknown(
            supabase,
            params.jobId,
            `Single lookup outcome requires manual reconciliation: ${msg}`,
            params.orgId,
            attemptToken,
            submissionSummary,
          );
          return summary;
        }

        summary.failed++;
        reportError(e, {
          tags: { surface: "skip_trace_lookup_single" },
          extra: { propertyId: misses[0].propertyId, jobId: params.jobId },
        });
        try {
          await insertJobItem(supabase, params.jobId, misses[0].propertyId, {
            status: "error",
            error_class: "provider_transient",
            error_message: msg,
          });
        } catch (insertErr) {
          reportError(insertErr, {
            tags: { surface: "skip_trace_lookup_single_item" },
            extra: { jobId: params.jobId, propertyId: misses[0].propertyId },
          });
          await safelyMarkSubmissionUnknown(
            supabase,
            params.jobId,
            `Single lookup rejection could not be durably recorded; manual reconciliation is required: ${insertErr instanceof Error ? insertErr.message : String(insertErr)}`,
            params.orgId,
            attemptToken,
            submissionSummary,
          );
          return summary;
        }
      }
      await finalizeJob(supabase, params.jobId, summary, {
        orgId: params.orgId,
        attemptToken,
      });
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
    const pendingSummary = {
      ...summary,
      batch_pending: true,
      submit_phase: "submitting",
      submit_phase_started_at: new Date().toISOString(),
      // The fan-out ledger. Keyed by `address|city|state` (lower).
      address_to_property_ids: mapAsObject,
      unique_addresses_submitted: uniqueByAddress.length,
    } as unknown as Json;

    let providerCallStarted = false;
    try {
      if (!batchHookCompleted) {
        await params.beforeBatchProviderEligibilityCheck?.();
        batchHookCompleted = true;
      }
      const finalEligibility = await resolveSkipTraceEligibility(supabase, {
        orgId: params.orgId,
        propertyIds: misses.map((miss) => miss.propertyId),
      });
      if (finalEligibility.exclusions.length > 0) {
        if ((await reconcileProviderExclusions()) === "stop") return summary;
        continue providerSubmission;
      }

      if (
        !(await heartbeatOwnedAttempt(supabase, {
          jobId: params.jobId,
          orgId: params.orgId,
          attemptToken,
        }))
      ) {
        return summary;
      }

      await checkpointProviderSubmission(supabase, {
        jobId: params.jobId,
        orgId: params.orgId,
        attemptToken,
        summary: pendingSummary,
      });

      providerCallStarted = true;
      const ticket = await provider.submitBatch(uniqueByAddress);
      const { data: ticketClaim, error: ticketErr } = await supabase
        .from("jobs")
        .update({
          provider_run_id: ticket.queueId,
          worker_heartbeat_at: new Date().toISOString(),
        })
        .eq("id", params.jobId)
        .eq("org_id", params.orgId)
        .eq("type", "skip_trace")
        .eq("status", "running")
        .contains("input_params", { submission_attempt_token: attemptToken })
        .is("provider_run_id", null)
        .select("id");
      if (ticketErr || !ticketClaim || ticketClaim.length === 0) {
        const msg =
          ticketErr?.message ??
          "provider_run_id was already set or the job disappeared after submit";
        reportError(new Error(msg), {
          tags: { surface: "skip_trace_persist_batch_ticket" },
          extra: {
            jobId: params.jobId,
            queueId: ticket.queueId,
            count: uniqueByAddress.length,
          },
        });
        // The provider boundary has already been crossed. Persist an explicit
        // non-retryable state rather than leaving a stale `submitting` row that
        // operators could mistake for an ordinary failed job.
        await safelyMarkSubmissionUnknown(
          supabase,
          params.jobId,
          `Provider accepted batch ${ticket.queueId}, but Sandra could not persist the ticket; manual reconciliation is required: ${msg}`,
          params.orgId,
          attemptToken,
          {
            ...(pendingSummary as Record<string, unknown>),
            provider_queue_id_for_reconciliation: ticket.queueId,
          } as unknown as Json,
        );
        return summary;
      }

      const { error: ticketSummaryErr } = await supabase
        .from("jobs")
        .update({
          result_summary: {
            ...(pendingSummary as Record<string, unknown>),
            submit_phase: "submitted",
            submit_phase_completed_at: new Date().toISOString(),
            estimated_wait_seconds: ticket.estimatedWaitSeconds,
            credits_per_lead: ticket.creditsPerLead,
          } as unknown as Json,
          worker_heartbeat_at: new Date().toISOString(),
        })
        .eq("id", params.jobId)
        .eq("org_id", params.orgId)
        .eq("type", "skip_trace")
        .eq("status", "running")
        .contains("input_params", { submission_attempt_token: attemptToken })
        .eq("provider_run_id", ticket.queueId);
      if (ticketSummaryErr) {
        reportError(ticketSummaryErr, {
          tags: { surface: "skip_trace_persist_batch_summary" },
          extra: {
            jobId: params.jobId,
            queueId: ticket.queueId,
            count: uniqueByAddress.length,
          },
        });
      }
      return { pending: true, queueId: ticket.queueId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (providerCallStarted && isSubmissionUnknownError(e)) {
        await safelyMarkSubmissionUnknown(
          supabase,
          params.jobId,
          `Batch submission outcome is unknown; manual provider reconciliation is required: ${msg}`,
          params.orgId,
          attemptToken,
          pendingSummary,
        );
      } else {
        await markJobFailed(
          supabase,
          params.jobId,
          `submitBatch rejected before acceptance: ${msg}`,
          params.orgId,
          attemptToken,
        );
      }
      reportError(e, {
        tags: { surface: "skip_trace_submit_batch" },
        extra: { jobId: params.jobId, count: uniqueByAddress.length },
      });
      return summary;
    }
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
  params: {
    jobId: string;
    results: SkipTraceResult[];
    /** Failure-injection seam used to prove that a result persisted before a
     * ledger outage is safely resumed without another provider submission. */
    beforeLedgerWrite?: (propertyId: string) => Promise<void>;
  },
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
    .select("result_summary, org_id");
  if (claimErr) {
    throw new Error(`finalize claim failed: ${claimErr.message}`);
  }
  if (!claimed || claimed.length === 0) {
    // Another finalizer owns (or already finished) this job.
    return null;
  }
  const jobRow = claimed[0];

  try {
    return await finalizeClaimed(
      supabase,
      { ...params, orgId: jobRow.org_id },
      jobRow.result_summary,
    );
  } catch (e) {
    // Give the job back so the next sweep tick can re-claim and retry —
    // a crashed finalizer must not strand the job in 'finalizing'.
    // EXCEPT when we lost the claim: the job now belongs to another
    // finalizer, and reverting would steal ITS claim and reopen the
    // overlap this whole mechanism exists to prevent.
    if (!(e instanceof ClaimLostError)) {
      await supabase
        .from("jobs")
        .update({ status: "running" })
        .eq("id", params.jobId)
        .eq("status", "finalizing");
    }
    throw e;
  }
}

/** Thrown when a finalizer discovers (at heartbeat time) that the sweep
 *  rescued its job away — the worker must abort without touching the
 *  job row, because a new owner is already working it. */
class ClaimLostError extends Error {
  constructor(jobId: string) {
    super(`finalize claim lost for job ${jobId} — rescued by sweep`);
    this.name = "ClaimLostError";
  }
}

type LedgerEntry = {
  status: string;
  errorClass: string | null;
  noMatch: boolean;
};

/** Error classes that are a FINAL answer for this run — resuming must
 *  not retry them. Everything else (database, provider_transient,
 *  provider_unknown, …) is a retry candidate on resume. */
const TERMINAL_ERROR_CLASSES = new Set([
  "provider_no_data",
  "address_unverified",
  "dnc_locked",
  "submission_unknown",
  "provider_persist_failed",
]);

/** Explicit precedence for duplicate rows per property (pre-resumability
 *  overlap damage): a persisted success outranks any error; a terminal
 *  error outranks a retryable one. Without this, the winner is UUID-
 *  order dependent and terminality becomes nondeterministic. */
function ledgerRank(entry: LedgerEntry): number {
  if (entry.status === "success") return 2;
  if (
    entry.status === "error" &&
    entry.errorClass &&
    TERMINAL_ERROR_CLASSES.has(entry.errorClass)
  ) {
    return 1;
  }
  return 0;
}

/**
 * Read the job's full job_items ledger, one entry per property. Keyset-
 * paged on the uuid PK with an explicit order — offset pages without an
 * ORDER BY have undefined boundaries and can skip/repeat rows.
 * Duplicate rows for one property collapse by `ledgerRank` precedence.
 * Also returns the row ids of retryable (non-terminal) ERROR items so a
 * resume can delete exactly those rows — and never a terminal error or
 * success row that happens to share the property.
 */
async function readItemLedger(
  supabase: SupabaseClient<Database>,
  jobId: string,
  onPage?: () => Promise<void>,
): Promise<{
  ledger: Map<string, LedgerEntry>;
  retryableErrorItemIds: string[];
}> {
  const ledger = new Map<string, LedgerEntry>();
  const retryableErrorItemIds: string[] = [];
  let lastId: string | null = null;
  for (;;) {
    let q = supabase
      .from("job_items")
      .select("id, property_id, status, error_class, output_payload")
      .eq("job_id", jobId)
      .order("id", { ascending: true })
      .limit(1000);
    if (lastId) q = q.gt("id", lastId);
    const { data, error } = await q;
    if (error) {
      // Fail closed — resuming or reconciling blind would corrupt the
      // ledger guarantee.
      throw new Error(`finalize ledger read failed: ${error.message}`);
    }
    for (const row of data ?? []) {
      lastId = row.id;
      if (!row.property_id) continue;
      const entry: LedgerEntry = {
        status: row.status,
        errorClass: row.error_class ?? null,
        noMatch:
          !!row.output_payload &&
          typeof row.output_payload === "object" &&
          (row.output_payload as Record<string, unknown>).no_match === true,
      };
      if (entry.status === "error" && ledgerRank(entry) === 0) {
        retryableErrorItemIds.push(row.id);
      }
      const prev = ledger.get(row.property_id);
      if (!prev || ledgerRank(entry) > ledgerRank(prev)) {
        ledger.set(row.property_id, entry);
      }
    }
    if (onPage) await onPage();
    if (!data || data.length < 1000) break;
  }
  return { ledger, retryableErrorItemIds };
}

async function finalizeClaimed(
  supabase: SupabaseClient<Database>,
  params: {
    jobId: string;
    orgId: string;
    results: SkipTraceResult[];
    beforeLedgerWrite?: (propertyId: string) => Promise<void>;
  },
  priorSummary: unknown,
): Promise<SkipTraceJobSummary> {
  const prior = (priorSummary ?? {}) as Partial<SkipTraceJobSummary> & {
    batch_pending?: boolean;
    address_to_property_ids?: Record<string, string[]>;
  };

  // Claim heartbeat + ownership fence, armed for the ENTIRE claimed
  // lifetime — including the pre-loop resume work below (ledger read,
  // retryable cleanup, props lookup), which is itself a dozen-plus DB
  // round trips that can stall on a degraded database. TIME-based
  // (checked at every step, written every ≤45s): a count-keyed
  // heartbeat would starve exactly when the rescue window matters. The
  // write doubles as the claim fence: it only matches while the job is
  // still 'finalizing' under our ownership; if the sweep rescued the
  // job away, we abort instead of double-writing alongside the new
  // owner. The fence is only as fresh as the last CONFIRMED write, so
  // failures retry on a short cadence and a worker that cannot prove
  // ownership for longer than the rescue window aborts conservatively
  // — the only realistic rescue-while-alive trigger is exactly this
  // can't-write-heartbeat state.
  const HEARTBEAT_INTERVAL_MS = 45_000;
  const HEARTBEAT_RETRY_MS = 10_000;
  // Just under the sweep's STALE_FINALIZING_MS (5 min) so we abort
  // before the rescue can hand the job to a new owner.
  const OWNERSHIP_PROOF_DEADLINE_MS = 4.5 * 60 * 1000;
  let lastAttemptAt = 0;
  let lastConfirmedAt = Date.now();
  const bumpHeartbeat = async () => {
    const now = Date.now();
    const sinceConfirmed = now - lastConfirmedAt;
    const interval =
      sinceConfirmed > HEARTBEAT_INTERVAL_MS
        ? HEARTBEAT_RETRY_MS
        : HEARTBEAT_INTERVAL_MS;
    if (now - lastAttemptAt < interval) return;
    lastAttemptAt = now;
    const { data, error } = await supabase
      .from("jobs")
      .update({ worker_heartbeat_at: new Date().toISOString() })
      .eq("id", params.jobId)
      .eq("status", "finalizing")
      .select("id");
    if (error) {
      // Transient heartbeat failure — keep working, but only while we
      // can still prove ownership inside the rescue window.
      if (sinceConfirmed > OWNERSHIP_PROOF_DEADLINE_MS) {
        throw new ClaimLostError(params.jobId);
      }
      return;
    }
    if (!data || data.length === 0) {
      throw new ClaimLostError(params.jobId);
    }
    lastConfirmedAt = Date.now();
  };

  // ------------------------------------------------------------------
  // RESUMABILITY. A 4,000-row finalize (~5 rows/s of sequential DB
  // writes) outlives the function's max duration — the 2026-06-12
  // recovery passes died at ~3,400 rows and the platform kill skips the
  // catch block, so the claim-revert never ran. The sweep's stale-
  // heartbeat rescue re-claims the job; THIS pass must then pick up
  // where the dead one stopped instead of re-writing every row.
  // job_items is the ledger: a property with a success or terminal-error
  // item was fully handled by a previous pass — skip it. Non-terminal
  // error items (database / provider_transient / provider_unknown) get
  // their rows deleted and the property reprocessed: a transient hiccup
  // in the dead pass must not become a permanent failure.
  // ------------------------------------------------------------------
  const { ledger: startLedger, retryableErrorItemIds } = await readItemLedger(
    supabase,
    params.jobId,
    bumpHeartbeat,
  );
  const alreadyProcessed = new Set<string>();
  for (const [pid, entry] of startLedger) {
    // ledgerRank 0 = retryable error → reprocess. Everything else
    // (success, terminal error) is settled for this run.
    if (ledgerRank(entry) > 0) alreadyProcessed.add(pid);
  }
  // Delete exactly the retryable error rows (by id — never a terminal
  // error or success row sharing the property) so the reprocess writes
  // a single fresh outcome per property.
  for (const ids of chunked(retryableErrorItemIds, IN_CHUNK)) {
    await bumpHeartbeat();
    const { error } = await supabase
      .from("job_items")
      .delete()
      .eq("job_id", params.jobId)
      .in("id", ids);
    if (error) {
      // Fail closed — reprocessing without the delete would duplicate.
      throw new Error(
        `finalize transient-item cleanup failed: ${error.message}`,
      );
    }
  }

  const addressMap: Record<string, string[]> | null =
    prior.address_to_property_ids &&
    typeof prior.address_to_property_ids === "object"
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
    ...(prior.eligibility_exclusions
      ? { eligibility_exclusions: prior.eligibility_exclusions }
      : {}),
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
    await bumpHeartbeat();
    const { data, error } = await supabase
      .from("properties")
      .select("id, address, city, state, zip, cass_status")
      .eq("org_id", params.orgId)
      .in("id", ids);
    if (error) {
      reportError(error, {
        tags: { surface: "skip_trace_finalize_props_lookup" },
        extra: { jobId: params.jobId, chunkSize: ids.length },
      });
      // Fail CLOSED. A partial propsById map silently misclassifies
      // every affected missing property as address_unverified and skips
      // its negative-cache write. Throwing reverts the claim
      // (finalizing→running) so the next sweep tick retries the whole
      // finalize against a healthy database.
      throw new Error(`finalize props lookup failed: ${error.message}`);
    }
    if (data) props.push(...data);
  }
  const propsById = new Map(props.map((p) => [p.id, p]));

  // Validate the entire submitted audience before writing either successful
  // or missing-result ledger rows. Checking only fanOut would leave forged
  // foreign IDs with no provider result able to reach the missing-item path.
  for (const propertyId of allRelatedPropertyIds) {
    if (!propsById.has(propertyId)) {
      throw new Error(
        `skip-trace result property is outside job organization: ${propertyId}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Apply results. Wrap each persist in try/catch so one bad row can't
  // break the rest of the batch.
  // ------------------------------------------------------------------
  for (const { propertyId, result } of fanOut) {
    if (alreadyProcessed.has(propertyId)) continue;
    await bumpHeartbeat();
    const p = propsById.get(propertyId);
    if (!p) {
      // The job-owned org lookup above is authoritative. A forged/legacy
      // provider map must never let this service-role finalizer mutate a
      // property from another tenant.
      throw new Error(
        `skip-trace result property is outside job organization: ${propertyId}`,
      );
    }
    await persistAndRecord(
      supabase,
      params.orgId,
      params.jobId,
      result,
      summary,
      /*fromCache*/ false,
      {
        requireLedgerWrite: true,
        beforeLedgerWrite: params.beforeLedgerWrite,
      },
    );

    try {
      await writeCache(
        supabase,
        params.orgId,
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
      // Cache failure is non-fatal after the terminal per-property ledger
      // outcome exists; retries will not pay the provider again.
      reportError(e, {
        tags: { surface: "skip_trace_finalize_cache_write" },
        extra: { jobId: params.jobId, propertyId },
      });
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
      if (alreadyProcessed.has(propertyId)) continue;
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

      await params.beforeLedgerWrite?.(propertyId);
      await insertJobItem(supabase, params.jobId, propertyId, {
        status: "error",
        error_class: klass,
        error_message: errorMessage,
      });

      // Cache the "no data" verdict for verified addresses so future
      // runs hit cache instead of re-paying the vendor. Skip
      // unverified — their normalized address will change once CASS
      // runs, so the cache key would be stale anyway.
      if (isCassVerified && p) {
        try {
          await writeCache(
            supabase,
            params.orgId,
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

  // ------------------------------------------------------------------
  // Terminal counters come from the job_items ledger, not memory. A
  // resumed pass only walked the remainder — its in-memory counters
  // miss everything the dead pass persisted. The ledger read dedupes by
  // property (job_items has no uniqueness on job_id+property_id, and
  // pre-resumability overlap damage left duplicate rows), so counters
  // can never exceed the distinct-property total.
  // (cached_hits/api_hits/total_credits stay in-memory: informational,
  // and the ledger doesn't carry credits per row.)
  // ------------------------------------------------------------------
  const { ledger: endLedger } = await readItemLedger(
    supabase,
    params.jobId,
    bumpHeartbeat,
  );
  let matchedTotal = 0;
  let noMatchTotal = 0;
  let failedTotal = 0;
  for (const entry of endLedger.values()) {
    if (entry.status === "success") {
      if (entry.noMatch) noMatchTotal++;
      else matchedTotal++;
    } else if (entry.status === "error") {
      failedTotal++;
    }
  }
  summary.matched = matchedTotal;
  summary.no_match = noMatchTotal;
  summary.failed = failedTotal;
  if (endLedger.size !== summary.total) {
    throw new Error(
      `finalize ledger count mismatch: expected ${summary.total}, found ${endLedger.size}`,
    );
  }

  await finalizeJob(supabase, params.jobId, summary, {
    requireFinalizing: true,
  });
  return summary;
}

// ---------- helpers ----------------------------------------------------

async function persistAndRecord(
  supabase: SupabaseClient<Database>,
  orgId: string,
  jobId: string,
  result: SkipTraceResult,
  summary: SkipTraceJobSummary,
  fromCache: boolean,
  ledger?: {
    requireLedgerWrite?: boolean;
    beforeLedgerWrite?: (propertyId: string) => Promise<void>;
  },
): Promise<void> {
  // A provider result is not terminal until its per-property ledger row is
  // durable. Paid callers opt into propagation so they can preserve a
  // reconciliation-safe state instead of finalizing away the uncertainty.
  const writeItem = async (
    fields: Parameters<typeof insertJobItem>[3],
  ): Promise<void> => {
    try {
      await ledger?.beforeLedgerWrite?.(result.propertyId);
      await insertJobItem(supabase, jobId, result.propertyId, fields);
    } catch (error) {
      reportError(error, {
        tags: { surface: "skip_trace_persist_record_insert" },
        extra: { jobId, propertyId: result.propertyId, status: fields.status },
      });
      if (ledger?.requireLedgerWrite) throw error;
    }
  };

  let outcome: PersistOutcome;
  try {
    outcome = await persistSkipTraceResult(supabase, orgId, result);
  } catch (e) {
    summary.failed++;
    const msg = e instanceof Error ? e.message : String(e);
    reportError(e, {
      tags: { surface: "skip_trace_persist" },
      extra: { jobId, propertyId: result.propertyId },
    });
    await writeItem({
      status: "error",
      error_class: fromCache ? "database" : "provider_persist_failed",
      error_message: msg,
    });
    return;
  }

  if (!fromCache) summary.api_hits++;
  summary.total_credits += result.creditsDeducted;

  if (outcome.status === "matched") {
    summary.matched++;
    await writeItem({
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
    await writeItem({
      status: "success",
      result: {
        from_cache: fromCache,
        credits_deducted: result.creditsDeducted,
        no_match: true,
      },
    });
  } else if (outcome.status === "dnc_contact_ambiguous") {
    summary.failed++;
    summary.dnc_contact_ambiguous = (summary.dnc_contact_ambiguous ?? 0) + 1;
    await writeItem({
      status: "error",
      // Existing terminal taxonomy: persistence completed fail-closed, but
      // identity ambiguity requires a human decision before any retry.
      error_class: "provider_persist_failed",
      error_message:
        "Manual review required: provider phone candidates map to multiple contacts. The property was not linked or marked permanently DNC.",
      result: {
        manual_review: true,
        reason: "dnc_contact_ambiguous",
        ambiguous_contact_ids: outcome.ambiguousContactIds ?? [],
      },
    });
  } else if (outcome.status === "dnc_skipped") {
    summary.failed++;
    summary.dnc_skipped = (summary.dnc_skipped ?? 0) + 1;
    await writeItem({
      status: "error",
      error_class: "dnc_locked",
      error_message:
        "Property became permanently DNC before the provider result could be persisted.",
    });
  } else {
    summary.failed++;
    await writeItem({
      status: "error",
      error_class: "database",
      error_message: "Property not found at persist time",
    });
  }
}

function isSubmissionUnknownError(error: unknown): boolean {
  return (
    !(error instanceof ProviderError) ||
    typeof error.details?.status !== "number"
  );
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
      | "provider_rejected"
      | "submission_unknown"
      | "provider_persist_failed"
      | "dnc_locked"
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
  opts?: {
    requireFinalizing?: boolean;
    orgId?: string;
    attemptToken?: string;
  },
): Promise<void> {
  const status: Database["public"]["Tables"]["jobs"]["Update"]["status"] =
    summary.failed === 0
      ? "completed"
      : summary.matched + summary.no_match === 0
        ? "failed"
        : "partial";

  // Batch finalizers must still OWN the job when writing terminal
  // state — a stale worker whose claim was rescued away must not
  // overwrite the new owner's job row. Sync paths (no claim machinery)
  // update unconditionally as before.
  let q = supabase
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
  if (opts?.orgId) {
    q = q.eq("org_id", opts.orgId);
  }
  if (opts?.attemptToken) {
    q = q.contains("input_params", {
      submission_attempt_token: opts.attemptToken,
    });
  }
  if (opts?.requireFinalizing) {
    q = q.eq("status", "finalizing");
  }
  const { data: updated, error: updateErr } = await q.select("id");
  if (updateErr) {
    throw new Error(`finalize terminal write failed: ${updateErr.message}`);
  }
  if (opts?.requireFinalizing && (!updated || updated.length === 0)) {
    throw new ClaimLostError(jobId);
  }
  if (opts?.attemptToken && (!updated || updated.length === 0)) return;

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
  orgId?: string,
  attemptToken?: string,
): Promise<void> {
  let query = supabase
    .from("jobs")
    .update({
      status: "canceled",
      completed_at: new Date().toISOString(),
      error_message: reason,
    })
    .eq("id", jobId);
  if (orgId) query = query.eq("org_id", orgId);
  if (attemptToken) {
    query = query.contains("input_params", {
      submission_attempt_token: attemptToken,
    });
  }
  const { error } = await query;
  if (error) throw new Error(`mark job canceled failed: ${error.message}`);
}

async function markJobFailed(
  supabase: SupabaseClient<Database>,
  jobId: string,
  reason: string,
  orgId?: string,
  attemptToken?: string,
): Promise<void> {
  let query = supabase
    .from("jobs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: reason,
    })
    .eq("id", jobId);
  if (orgId) query = query.eq("org_id", orgId);
  if (attemptToken) {
    query = query.contains("input_params", {
      submission_attempt_token: attemptToken,
    });
  }
  const { error } = await query;
  if (error) throw new Error(`mark job failed failed: ${error.message}`);
}

async function markSubmissionUnknown(
  supabase: SupabaseClient<Database>,
  jobId: string,
  reason: string,
  orgId: string,
  attemptToken: string,
  priorSummary: Json,
): Promise<void> {
  const summary = {
    ...(priorSummary as Record<string, unknown>),
    submit_phase: "submission_unknown",
    manual_reconciliation_required: true,
  } as unknown as Json;
  const { data, error } = await supabase
    .from("jobs")
    .update({
      status: "canceled",
      error_class: "submission_unknown",
      error_message: reason,
      result_summary: summary,
      completed_at: new Date().toISOString(),
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("org_id", orgId)
    .eq("type", "skip_trace")
    .contains("input_params", { submission_attempt_token: attemptToken })
    .select("id");
  if (error || !data || data.length !== 1) {
    throw new Error(
      `mark submission unknown failed: ${error?.message ?? "claim lost"}`,
    );
  }
}

async function safelyMarkSubmissionUnknown(
  supabase: SupabaseClient<Database>,
  jobId: string,
  reason: string,
  orgId: string,
  attemptToken: string,
  priorSummary: Json,
): Promise<void> {
  try {
    await markSubmissionUnknown(
      supabase,
      jobId,
      reason,
      orgId,
      attemptToken,
      priorSummary,
    );
  } catch (error) {
    // The pre-submit claim already left submit_phase='submitting'. If the
    // reconciliation marker cannot be persisted, that state still blocks the
    // automatic retry path and therefore avoids a second provider charge.
    reportError(error, {
      tags: { surface: "skip_trace_mark_submission_unknown" },
      extra: { jobId, reason },
    });
  }
}
