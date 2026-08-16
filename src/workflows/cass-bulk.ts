/**
 * Bulk CASS verification workflow — Vercel Workflow DevKit version.
 *
 * Replaces the legacy `after(() => runCassEnrichment(...))` callback in
 * verifyPropertiesBulk (leads/actions.ts) and startQueuedCassJob
 * (jobs/actions.ts), which hit Vercel's 5-minute function ceiling on
 * large selections — observed live 2026-06-11: an 11,134-row bulk verify
 * died silently at ~1,830 rows (heartbeat stopped at exactly 4m59s) while
 * the job row stayed "running" forever.
 *
 * Same shape as csv-import.ts:
 *   1. loadCassJobIds — read property_ids from jobs.input_params, flip
 *      the job to running (beginCassJob)
 *   2. cassChunkStep  — verify one fixed-size slice; cumulative progress
 *   3. finalizeCassStep — terminal status + result_summary + notification
 *
 * Each step is a separate function invocation, so total wall-clock has no
 * platform cap — only per-step caps, which CHUNK_SIZE keeps clear of.
 *
 * Invariants:
 * - Steps are pure functions of their inputs + DB state. WDK persists step
 *   results, so a completed chunk never re-runs on replay.
 * - The workflow body only orchestrates; all I/O lives in steps.
 */

import {
  beginCassJob,
  finalizeCassJob,
  runCassChunk,
  type CassJobSummary,
} from "@/lib/enrichment/cass-job";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Per-chunk row count. The live 2026-06-11 stall processed ~1,830 rows in
 * 4m59s (~370 rows/min on the cache-miss path). 250 rows ≈ 40–70s per
 * step — the same empirical sizing csv-import.ts uses for its
 * CASS-touching chunks, with wide headroom under the per-step cap.
 */
const CHUNK_SIZE = 250;

export type CassBulkWorkflowParams = {
  /** Job row (type cass_dsf2_ncoa) whose input_params.property_ids holds
   *  the verification targets. Both producers write this shape:
   *  verifyPropertiesBulk and createCassChildJob. */
  jobId: string;
};

/**
 * STEP 1 — Read the target property IDs off the job row and flip it to
 * running. Throwing here (missing job / empty ids) fails the workflow
 * before any verification spend.
 */
export async function loadCassJobIds(
  jobId: string,
): Promise<{ orgId: string; propertyIds: string[] }> {
  "use step";

  const supabase = createAdminClient();

  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, org_id, type, status, input_params")
    .eq("id", jobId)
    .single();

  if (error || !job) {
    throw new Error(
      `CASS bulk workflow: job ${jobId} not found: ${error?.message ?? "no row"}`,
    );
  }
  if (job.type !== "cass_dsf2_ncoa") {
    throw new Error(`CASS bulk workflow: job ${jobId} has type ${job.type}`);
  }
  if (job.status !== "queued" && job.status !== "running") {
    throw new Error(`CASS bulk workflow: job ${jobId} is ${job.status}`);
  }

  const raw =
    (job.input_params as { property_ids?: unknown } | null)?.property_ids ??
    null;
  const propertyIds = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];

  if (propertyIds.length === 0) {
    throw new Error(
      `CASS bulk workflow: job ${jobId} has no property IDs in input_params`,
    );
  }

  const uniquePropertyIds = Array.from(new Set(propertyIds));
  const { data: ownedProperties, error: propertyError } = await supabase
    .from("properties")
    .select("id")
    .eq("org_id", job.org_id)
    .in("id", uniquePropertyIds);
  if (propertyError) {
    throw new Error(
      `CASS bulk workflow: property ownership check failed: ${propertyError.message}`,
    );
  }
  const ownedIds = new Set((ownedProperties ?? []).map((row) => row.id));
  const foreignOrMissing = uniquePropertyIds.filter((id) => !ownedIds.has(id));
  if (foreignOrMissing.length > 0) {
    throw new Error(
      `CASS bulk workflow: ${foreignOrMissing.length} property ID(s) do not belong to job organization`,
    );
  }

  await beginCassJob(supabase, { jobId, totalItems: uniquePropertyIds.length });

  return { orgId: job.org_id, propertyIds: uniquePropertyIds };
}

/**
 * STEP 2 — Verify one slice. Thin step boundary around runCassChunk; the
 * per-row outcome handling, job_items writes, and cumulative progress
 * updates live in src/lib/enrichment/cass-job.ts.
 *
 * Step retry semantics: per-row provider/database failures are absorbed
 * into job_items by runCassChunk, so a step only throws on infrastructure
 * errors — exactly what WDK retry-with-backoff is for. verifyPropertyAddress
 * is cache-through, so a retried chunk re-reads cached verdicts instead of
 * re-spending provider lookups.
 */
async function cassChunkStep(args: {
  jobId: string;
  propertyIds: string[];
  processedBefore: number;
  summary: CassJobSummary;
  expectedOrgId: string;
}): Promise<CassJobSummary> {
  "use step";

  const supabase = createAdminClient();
  return runCassChunk(supabase, args);
}

/** STEP 3 — Terminal status, result_summary, initiator notification. */
async function finalizeCassStep(args: {
  jobId: string;
  summary: CassJobSummary;
}): Promise<void> {
  "use step";

  const supabase = createAdminClient();
  await finalizeCassJob(supabase, args);
}

/**
 * `start(cassBulkWorkflow, [{ jobId }])`. Orchestrates load → chunk loop →
 * finalize for one cass_dsf2_ncoa job of any size.
 */
export async function cassBulkWorkflow(
  params: CassBulkWorkflowParams,
): Promise<CassJobSummary> {
  "use workflow";

  const { orgId, propertyIds } = await loadCassJobIds(params.jobId);

  let summary: CassJobSummary = {
    total: propertyIds.length,
    verified: 0,
    invalid: 0,
    ambiguous: 0,
    cacheHits: 0,
    failed: 0,
    providerOff: 0,
  };

  for (let offset = 0; offset < propertyIds.length; offset += CHUNK_SIZE) {
    summary = await cassChunkStep({
      jobId: params.jobId,
      propertyIds: propertyIds.slice(offset, offset + CHUNK_SIZE),
      processedBefore: offset,
      summary,
      expectedOrgId: orgId,
    });
  }

  await finalizeCassStep({ jobId: params.jobId, summary });

  return summary;
}
