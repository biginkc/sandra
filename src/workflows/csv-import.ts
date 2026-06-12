/**
 * CSV import workflow — Vercel Workflow DevKit version.
 *
 * Replaces the legacy `after(() => runIngestion(...))` callback in
 * src/app/(dashboard)/import/actions.ts, which hit Vercel's 5-minute
 * function timeout on imports of ~2K rows. The workflow body orchestrates
 * three steps; each step runs in a separate function invocation so the
 * total wall-clock has no platform cap, only per-step caps.
 *
 *   1. loadCsvFromStorage   — download from Supabase Storage, parse,
 *                              return trimmed rows + total
 *   2. processChunkStep     — process one fixed-size slice of rows
 *                              (chunk size sized to fit comfortably
 *                              under the per-step timeout)
 *   3. finalizeIngestion    — set jobs.status terminal, update counters
 *
 * `prepareIngestion` (auto-tag resolution + initial heartbeat) runs in
 * step 1's tail so we don't pay an extra invocation just to flip a flag.
 *
 * Invariants:
 * - Steps are pure functions of their inputs + the DB state. WDK persists
 *   step results for replay, so a step that completes once doesn't re-run.
 * - The workflow body only orchestrates; all I/O lives in steps. Required
 *   because workflow bodies run in a sandboxed VM (no Node modules).
 */

import Papa from "papaparse";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createCassChildJob,
  getAutotriggerCap,
  runCassEnrichment,
  selectCassEligibleProperties,
} from "@/lib/enrichment/cass-job";
import {
  finalizeIngestion,
  prepareIngestion,
  processIngestChunk,
  type ChunkResult,
} from "@/lib/csv/ingest";
import {
  applyLineTypes,
  collectUnlabeledPhones,
  summarizeClassification,
  type ClassificationCounts,
} from "@/lib/csv/line-type-classify";
import {
  telnyxLookupFromEnv,
  TELNYX_LOOKUP_COST_USD,
} from "@/lib/line-type-lookup/telnyx";
import { enrollLead } from "@/lib/sequences/enrollment";
import { trimRowsToMapping } from "@/lib/csv/trim-rows";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import type { Mapping, RowData } from "@/lib/csv/validate";
import type { PhoneLineType } from "@/lib/messaging/line-type";

/**
 * Per-chunk row count. 250 was chosen empirically: at the per-row latency
 * we observed in the prod stall (~95 rows/min for the heavy CASS-touching
 * path), 250 rows takes ~2.5 min — well under the 5-min function cap with
 * comfortable headroom for the tail-end p95 outliers.
 */
const CHUNK_SIZE = 250;

/**
 * Numbers per Telnyx-classification step. At 5 lookups in flight and
 * ~300ms each, 200 numbers is ~12s — far under the per-step cap even
 * with the one-retry backoff on every number.
 */
const LOOKUP_CHUNK_SIZE = 200;

export type CsvImportWorkflowParams = {
  jobId: string;
  csvImportId: string;
  storagePath: string;
  source: string;
  market: string;
  /** county_id chosen at job-create time. Set in lockstep with `market`
   *  per phase 02 D-04 — workflow threads it through every chunk so
   *  ingestRow can populate `properties.county_id` at insert time.
   *  Nullable for the defensive-recovery branch (see workflow body):
   *  if null on entry the workflow re-reads it from csv_imports.county_id
   *  (column added by migration 043) — makes the async boundary
   *  self-healing for jobs queued before this plan shipped. */
  countyId: string | null;
  mapping: Mapping;
  listId: string | null;
  userId: string | null;
  /** When true, bulk-record opt_in_marketing_written for every homeowner
   *  contact that was created or matched in this import. */
  smsConsent?: boolean;
  /** When set, auto-enroll every successfully imported property into this
   *  sequence after consent is recorded. */
  sequenceId?: string | null;
  /** When true, classify unlabeled phone numbers via Telnyx before the
   *  ingest chunks run. Off (or TELNYX_API_KEY unset) = unlabeled
   *  numbers are dropped by the ingest hard rule and counted. */
  classifyLineTypes?: boolean;
};

export type EnrollBatchResult = {
  enrolled: number;
  skipped: number;
  failed: number;
};

/**
 * Enroll every succeeded job_item's property into the given sequence.
 * Outcomes: "enrolled" → enrolled, "failed" → failed, anything else → skipped.
 * Never throws — partial failures are counted and execution continues.
 */
export async function enrollJobBatch(
  supabase: SupabaseClient<Database>,
  args: { jobId: string; sequenceId: string },
): Promise<EnrollBatchResult> {
  const { data: items } = await supabase
    .from("job_items")
    .select("property_id")
    .eq("job_id", args.jobId)
    .eq("status", "success");

  const propertyIds = (items ?? [])
    .map((i) => i.property_id)
    .filter((id): id is string => id !== null);

  let enrolled = 0;
  let skipped = 0;
  let failed = 0;

  for (const propertyId of propertyIds) {
    try {
      const outcome = await enrollLead(supabase, {
        sequenceId: args.sequenceId,
        propertyId,
      });
      if (outcome.status === "enrolled") enrolled++;
      else if (outcome.status === "failed") failed++;
      else skipped++;
    } catch {
      failed++;
    }
  }

  return { enrolled, skipped, failed };
}

/**
 * STEP 1 — Download the CSV from Storage, parse, trim to mapped columns,
 * resolve auto-tags. Combines the download + prepare phases so the
 * workflow has the full row array + tag IDs in one piece of state.
 *
 * Returns the trimmed rows array; the workflow body slices it into chunks.
 * The serialized array is persisted in the workflow event log — for a 2K-
 * row D4D file at ~30 mapped cols × 20 bytes that's ~1 MB of step state.
 * Acceptable today; if step state becomes a cost concern at scale, swap
 * this for a "store rows in csv_imports.input_rows JSONB and have each
 * chunk read a SQL slice" pattern.
 */
async function loadCsvFromStorage(
  storagePath: string,
  mapping: Mapping,
  jobId: string,
  source: string,
): Promise<{ rows: RowData[]; totalRows: number; autoTagIds: string[] }> {
  "use step";

  const supabase = createAdminClient();

  const { data: blob, error } = await supabase.storage
    .from("csv-imports")
    .download(storagePath);

  if (error || !blob) {
    throw new Error(
      `Failed to download CSV from storage: ${error?.message ?? "no blob"}`,
    );
  }

  const text = await blob.text();
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    // Surface the first parse error but don't abort — papaparse flags
    // recoverable issues (extra commas, unmatched quotes) on individual
    // rows that the validator will then reject as malformed.
    console.warn(
      `CSV parse warnings (${parsed.errors.length}); first: ${parsed.errors[0]?.message}`,
    );
  }

  const trimmedRows = trimRowsToMapping(parsed.data, mapping);

  const { autoTagIds } = await prepareIngestion(supabase, {
    jobId,
    totalRows: trimmedRows.length,
    source,
  });

  return {
    rows: trimmedRows,
    totalRows: trimmedRows.length,
    autoTagIds,
  };
}

/**
 * STEP 1b — Find the distinct phone numbers that would ingest with type
 * 'unknown' (the set the migration-080 hard rule would drop). Also
 * reports whether Telnyx is configured — env access lives in steps, not
 * the sandboxed workflow body.
 */
async function collectUnlabeledPhonesStep(args: {
  rows: RowData[];
  mapping: Mapping;
}): Promise<{ numbers: string[]; telnyxConfigured: boolean }> {
  "use step";

  return {
    numbers: collectUnlabeledPhones(args.rows, args.mapping),
    telnyxConfigured: !!process.env.TELNYX_API_KEY?.trim(),
  };
}

/**
 * STEP 1c — Classify one slice of phone numbers via Telnyx. Returns
 * entries (not a Map — step results must serialize). The provider never
 * throws on a single number's failure; a thrown error here means Telnyx
 * is unreachable outright, which WDK retries with backoff.
 */
async function classifyPhonesChunkStep(args: {
  numbers: string[];
}): Promise<[string, PhoneLineType][]> {
  "use step";

  const lookup = telnyxLookupFromEnv();
  const classified = await lookup.classify(args.numbers);
  return [...classified.entries()];
}

/**
 * Mark the job failed with an operator-readable error. Used when the
 * operator approved paid classification but the lookup can't run —
 * failing fast beats silently dropping the numbers they paid to keep.
 */
async function failJobStep(args: {
  jobId: string;
  message: string;
}): Promise<void> {
  "use step";

  const supabase = createAdminClient();
  await supabase
    .from("jobs")
    .update({
      status: "failed",
      error_message: args.message,
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.jobId);
}

/**
 * STEP 1d — Write classified types back into the rows (and extend the
 * mapping with synthetic type columns where the file had none), then
 * record the classification counts + estimated cost on the job row so
 * the operator sees what the lookup found before ingest finishes. The
 * same counts ride into the final result_summary via finalizeStep.
 */
async function applyLineTypesStep(args: {
  jobId: string;
  rows: RowData[];
  mapping: Mapping;
  classified: [string, PhoneLineType][];
}): Promise<{
  rows: RowData[];
  mapping: Mapping;
  counts: ClassificationCounts;
}> {
  "use step";

  const classified = new Map(args.classified);
  const applied = applyLineTypes(args.rows, args.mapping, classified);
  const counts = summarizeClassification(classified, TELNYX_LOOKUP_COST_USD);

  const supabase = createAdminClient();
  await supabase
    .from("jobs")
    .update({
      result_summary: { lineTypeClassification: counts },
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", args.jobId);

  return { rows: applied.rows, mapping: applied.mapping, counts };
}

/**
 * STEP 2 — Ingest one slice of rows. Thin wrapper around processIngestChunk
 * with the workflow-shaped step boundary; the heavy lifting (validation,
 * dedup, contact upsert, tag application, job_items writes, progress
 * updates) lives in src/lib/csv/ingest.ts.
 *
 * Step retry semantics: on a transient throw, WDK retries with backoff.
 * processIngestChunk wraps every per-row failure in a try/catch and writes
 * the error to job_items, so the only way a step throws is on infrastructure
 * issues (DB unreachable, etc.) — exactly what retry is for.
 */
async function processChunkStep(args: {
  jobId: string;
  csvImportId: string;
  source: string;
  market: string;
  /** county_id threaded through from the workflow params (D-04). The
   *  worker passes this into ingestRow which sets it alongside
   *  `properties.market` at insert time. */
  countyId: string | null;
  mapping: Mapping;
  rows: RowData[];
  offset: number;
  autoTagIds: string[];
  listId: string | null;
  userId: string | null;
  /** Running totals from prior chunks, threaded so the chunk's
   *  per-row progress writes report cumulative succeeded/failed across
   *  the whole job (not just this chunk). */
  priorSucceeded: number;
  priorFailed: number;
}): Promise<ChunkResult> {
  "use step";

  const supabase = createAdminClient();
  return processIngestChunk(supabase, {
    jobId: args.jobId,
    csvImportId: args.csvImportId,
    source: args.source,
    market: args.market,
    countyId: args.countyId,
    mapping: args.mapping,
    rows: args.rows,
    offset: args.offset,
    autoTagIds: args.autoTagIds,
    listId: args.listId,
    userId: args.userId,
    priorSucceeded: args.priorSucceeded,
    priorFailed: args.priorFailed,
  });
}

/**
 * STEP 3a — CASS auto-trigger. Creates a child cass job for every
 * eligible property and (when under the autotrigger cap) kicks off the
 * enrichment in the same step. Failure here does NOT flip the parent
 * import; child job records the issue independently.
 *
 * Eligibility (`selectCassEligibleProperties`): newly-inserted rows AND
 * dedup-matched rows whose `cass_status='unverified'`. The dedup-matched
 * branch fixes a recovery hole where re-importing addresses that pre-dated
 * CASS verification (or whose first CASS run never reached the verifier)
 * would otherwise be skipped here and stay stuck at unverified — blocking
 * downstream skip-trace via the PR #62 pre-flight gate. Terminal verdicts
 * (verified/invalid/ambiguous) and 'error' (handled by retryFailedCassItems)
 * are excluded.
 *
 * Skip-trace request (Surface C) is intentionally NOT in this workflow —
 * `requestSkipTrace` needs a user session for the admin/VA branching, and
 * workflow steps run with the service-role admin client. Added back as a
 * separate path when the wizard's StepDone component fires it on the
 * client side after the workflow completes.
 */
async function triggerCassStep(args: {
  parentJobId: string;
  relatedImportId: string;
  createdBy: string | null;
}): Promise<void> {
  "use step";

  const supabase = createAdminClient();

  const propertyIds = await selectCassEligibleProperties(
    supabase,
    args.parentJobId,
  );

  if (propertyIds.length === 0) return;

  const cap = getAutotriggerCap();
  const autoStart = propertyIds.length <= cap;
  const childId = await createCassChildJob(supabase, {
    parentJobId: args.parentJobId,
    relatedImportId: args.relatedImportId,
    createdBy: args.createdBy,
    propertyIds,
    autoStart,
    blockedReason: autoStart
      ? undefined
      : `${propertyIds.length} items exceeds CASS_AUTOTRIGGER_MAX_ITEMS=${cap}`,
  });

  if (autoStart) {
    await runCassEnrichment(supabase, { jobId: childId, propertyIds });
  }
}

/**
 * STEP 3b — Bulk-record opt_in_marketing_written for every homeowner contact
 * linked to a succeeded row in this import. Fires only when the operator
 * checked the SMS consent attestation box on the confirm screen.
 *
 * Queries job_items for succeeded property IDs, then joins to properties to
 * get homeowner_contact_id, then bulk-inserts consent_events. Skips contacts
 * that already have an opted_out event (opt-outs are irrevocable).
 */
async function recordConsentStep(args: {
  jobId: string;
}): Promise<void> {
  "use step";

  const supabase = createAdminClient();

  const { data: items } = await supabase
    .from("job_items")
    .select("property_id")
    .eq("job_id", args.jobId)
    .eq("status", "success");

  const propertyIds = (items ?? [])
    .map((i) => i.property_id)
    .filter((id): id is string => id !== null);

  if (propertyIds.length === 0) return;

  const { data: properties } = await supabase
    .from("properties")
    .select("homeowner_contact_id")
    .in("id", propertyIds)
    .not("homeowner_contact_id", "is", null);

  const contactIds = (properties ?? [])
    .map((p) => p.homeowner_contact_id)
    .filter((id): id is string => id !== null);

  if (contactIds.length === 0) return;

  // Skip contacts that have already explicitly opted out — opt-outs are
  // irrevocable and must not be overwritten by a batch attestation.
  const { data: optedOut } = await supabase
    .from("consent_events")
    .select("contact_id")
    .in("contact_id", contactIds)
    .in("event_type", ["opt_out", "provider_auto_opt_out"]);

  const optedOutIds = new Set((optedOut ?? []).map((r) => r.contact_id));
  const eligible = contactIds.filter((id) => !optedOutIds.has(id));

  if (eligible.length === 0) return;

  const now = new Date().toISOString();
  await supabase.from("consent_events").insert(
    eligible.map((contactId) => ({
      contact_id: contactId,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: `import_attestation:job:${args.jobId}`,
      occurred_at: now,
    })),
  );
}

/**
 * STEP 3b — Auto-enroll every succeeded import item into a sequence.
 * Fires only when the operator selected a sequence on the confirm screen.
 */
async function enrollInSequenceStep(args: {
  jobId: string;
  sequenceId: string;
}): Promise<EnrollBatchResult> {
  "use step";

  return enrollJobBatch(createAdminClient(), args);
}

/**
 * STEP 3 — Mark the job + csv_imports terminal. Single shot at the end of
 * the chunk loop.
 */
async function finalizeStep(args: {
  jobId: string;
  csvImportId: string;
  totalRows: number;
  succeeded: number;
  failed: number;
  skipped: number;
  droppedUnlabeledPhones: number;
  lineTypeClassification: ClassificationCounts | null;
  errors: { rowIndex: number; message: string }[];
}): Promise<void> {
  "use step";

  const supabase = createAdminClient();
  await finalizeIngestion(supabase, args);
}

/**
 * Workflow entrypoint. Started from the import server action via
 * `start(csvImportWorkflow, [params])`. Orchestrates load → chunk loop →
 * finalize. CASS auto-trigger and opt-in skip-trace are intentionally NOT
 * included here yet — they belong in their own follow-up workflow that
 * fires off a hook once this one completes (next PR).
 */
export async function csvImportWorkflow(
  params: CsvImportWorkflowParams,
): Promise<{
  succeeded: number;
  failed: number;
  skipped: number;
  totalRows: number;
}> {
  "use workflow";

  const loaded = await loadCsvFromStorage(
    params.storagePath,
    params.mapping,
    params.jobId,
    params.source,
  );

  // Defensive recovery (D-04): if `params.countyId` is null we are
  // running a job that was queued before this plan shipped, OR a
  // retry of one. The createImportJob action always persists
  // `csv_imports.county_id` (column added by migration 043) so the
  // worker can self-heal by reading it back from the import row. The
  // workflow params remain the hot path for in-flight jobs queued
  // after this ships — the DB read fires only on legacy paths.
  let countyId = params.countyId;
  if (countyId === null) {
    const supabase = createAdminClient();
    const { data: row } = await supabase
      .from("csv_imports")
      .select("county_id")
      .eq("id", params.csvImportId)
      .single();
    countyId = row?.county_id ?? null;
  }

  // Pre-ingest line-type classification (Telnyx). Only when the operator
  // opted in at the wizard's interstitial AND the API key is configured —
  // otherwise unlabeled numbers fall through to the ingest hard rule,
  // which drops and counts them. Classified types are written back into
  // the rows/mapping that the ingest chunks below consume.
  let rows = loaded.rows;
  let mapping = params.mapping;
  let lineTypeClassification: ClassificationCounts | null = null;
  if (params.classifyLineTypes) {
    const collected = await collectUnlabeledPhonesStep({ rows, mapping });
    // The operator explicitly approved paid classification — silently
    // falling through to the drop path would discard the very numbers
    // they paid to keep. Fail the job fast with a config error instead.
    if (!collected.telnyxConfigured && collected.numbers.length > 0) {
      await failJobStep({
        jobId: params.jobId,
        message:
          "Line-type classification was requested but TELNYX_API_KEY is not configured. " +
          "Add the key (Vercel env) and re-run the import, or choose 'Skip — drop unlabeled numbers'.",
      });
      return {
        succeeded: 0,
        failed: 0,
        skipped: 0,
        totalRows: loaded.totalRows,
      };
    }
    if (collected.telnyxConfigured && collected.numbers.length > 0) {
      // Chunked like the ingest loop so a big file's lookups never push
      // a single invocation past the function time cap.
      const entries: [string, PhoneLineType][] = [];
      for (
        let offset = 0;
        offset < collected.numbers.length;
        offset += LOOKUP_CHUNK_SIZE
      ) {
        const slice = collected.numbers.slice(
          offset,
          offset + LOOKUP_CHUNK_SIZE,
        );
        entries.push(...(await classifyPhonesChunkStep({ numbers: slice })));
      }
      const applied = await applyLineTypesStep({
        jobId: params.jobId,
        rows,
        mapping,
        classified: entries,
      });
      rows = applied.rows;
      mapping = applied.mapping;
      lineTypeClassification = applied.counts;
    }
  }

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let droppedUnlabeledPhones = 0;
  const allErrors: { rowIndex: number; message: string }[] = [];

  for (let offset = 0; offset < loaded.totalRows; offset += CHUNK_SIZE) {
    const slice = rows.slice(offset, offset + CHUNK_SIZE);
    const result = await processChunkStep({
      jobId: params.jobId,
      csvImportId: params.csvImportId,
      source: params.source,
      market: params.market,
      countyId,
      mapping,
      rows: slice,
      offset,
      autoTagIds: loaded.autoTagIds,
      listId: params.listId,
      userId: params.userId,
      priorSucceeded: succeeded,
      priorFailed: failed,
    });
    succeeded += result.succeeded;
    failed += result.failed;
    skipped += result.skipped;
    droppedUnlabeledPhones += result.droppedUnlabeledPhones;
    allErrors.push(...result.errors);
  }

  await finalizeStep({
    jobId: params.jobId,
    csvImportId: params.csvImportId,
    totalRows: loaded.totalRows,
    succeeded,
    failed,
    skipped,
    droppedUnlabeledPhones,
    lineTypeClassification,
    errors: allErrors,
  });

  await triggerCassStep({
    parentJobId: params.jobId,
    relatedImportId: params.csvImportId,
    createdBy: params.userId,
  });

  if (params.smsConsent) {
    await recordConsentStep({ jobId: params.jobId });
  }

  if (params.sequenceId) {
    await enrollInSequenceStep({
      jobId: params.jobId,
      sequenceId: params.sequenceId,
    });
  }

  return {
    succeeded,
    failed,
    skipped,
    totalRows: loaded.totalRows,
  };
}
