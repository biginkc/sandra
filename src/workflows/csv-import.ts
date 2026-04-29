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

import {
  createCassChildJob,
  getAutotriggerCap,
  runCassEnrichment,
} from "@/lib/enrichment/cass-job";
import {
  finalizeIngestion,
  prepareIngestion,
  processIngestChunk,
  type ChunkResult,
} from "@/lib/csv/ingest";
import { trimRowsToMapping } from "@/lib/csv/trim-rows";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Mapping, RowData } from "@/lib/csv/validate";

/**
 * Per-chunk row count. 250 was chosen empirically: at the per-row latency
 * we observed in the prod stall (~95 rows/min for the heavy CASS-touching
 * path), 250 rows takes ~2.5 min — well under the 5-min function cap with
 * comfortable headroom for the tail-end p95 outliers.
 */
const CHUNK_SIZE = 250;

export type CsvImportWorkflowParams = {
  jobId: string;
  csvImportId: string;
  storagePath: string;
  source: string;
  market: string;
  mapping: Mapping;
  listId: string | null;
  userId: string | null;
};

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
  mapping: Mapping;
  rows: RowData[];
  offset: number;
  autoTagIds: string[];
  listId: string | null;
  userId: string | null;
}): Promise<ChunkResult> {
  "use step";

  const supabase = createAdminClient();
  return processIngestChunk(supabase, {
    jobId: args.jobId,
    csvImportId: args.csvImportId,
    source: args.source,
    market: args.market,
    mapping: args.mapping,
    rows: args.rows,
    offset: args.offset,
    autoTagIds: args.autoTagIds,
    listId: args.listId,
    userId: args.userId,
  });
}

/**
 * STEP 3a — CASS auto-trigger. Creates a child cass job for every
 * newly-inserted property, and (when under the autotrigger cap) kicks off
 * the enrichment in the same step. Failure here does NOT flip the parent
 * import; child job records the issue independently.
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

  const { data: items } = await supabase
    .from("job_items")
    .select("property_id")
    .eq("job_id", args.parentJobId)
    .eq("status", "success")
    .not("property_id", "is", null);

  const propertyIds = (items ?? [])
    .map((r) => r.property_id)
    .filter((id): id is string => typeof id === "string");

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

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const allErrors: { rowIndex: number; message: string }[] = [];

  for (let offset = 0; offset < loaded.totalRows; offset += CHUNK_SIZE) {
    const slice = loaded.rows.slice(offset, offset + CHUNK_SIZE);
    const result = await processChunkStep({
      jobId: params.jobId,
      csvImportId: params.csvImportId,
      source: params.source,
      market: params.market,
      mapping: params.mapping,
      rows: slice,
      offset,
      autoTagIds: loaded.autoTagIds,
      listId: params.listId,
      userId: params.userId,
    });
    succeeded += result.succeeded;
    failed += result.failed;
    skipped += result.skipped;
    allErrors.push(...result.errors);
  }

  await finalizeStep({
    jobId: params.jobId,
    csvImportId: params.csvImportId,
    totalRows: loaded.totalRows,
    succeeded,
    failed,
    skipped,
    errors: allErrors,
  });

  await triggerCassStep({
    parentJobId: params.jobId,
    relatedImportId: params.csvImportId,
    createdBy: params.userId,
  });

  return {
    succeeded,
    failed,
    skipped,
    totalRows: loaded.totalRows,
  };
}
