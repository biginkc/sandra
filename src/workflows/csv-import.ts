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
import { createHash } from "node:crypto";

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
  type TelnyxLineTypeLookup,
} from "@/lib/line-type-lookup/telnyx";
import { enrollLead } from "@/lib/sequences/enrollment";
import { LEAD_EVENT_TYPES, recordLeadEvents } from "@/lib/events";
import { trimRowsToMapping } from "@/lib/csv/trim-rows";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import { validateRow, type Mapping, type RowData } from "@/lib/csv/validate";
import { SUPPRESSED_DISPOS } from "@/lib/messaging/suppression";
import type { ImportSideEffects } from "@/lib/csv/import-job-status";
import {
  REVIEWED_DATASET_VERSION,
  reviewContractJson,
  type ReviewContractInput,
} from "@/lib/csv/dataset-contract";
import { IMPORT_SERVICE_PRICING } from "@/lib/csv/import-pricing";
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
const SEQUENCE_ITEM_PAGE_SIZE = 500;
const POSTGREST_IN_CHUNK_SIZE = 500;
const LINE_TYPE_LEDGER_WORKERS = 5;

type LineTypeClaim = {
  action: "claimed" | "reused" | "ambiguous" | "retry_blocked";
  line_type: PhoneLineType | null;
  outcome: string | null;
};

type UntypedRpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    data: unknown;
    error: { message: string } | null;
  }>;
};

async function claimLineTypeLookup(
  supabase: SupabaseClient<Database>,
  args: { jobId: string; orgId: string; phone: string },
): Promise<LineTypeClaim> {
  const { data, error } = await (supabase as unknown as UntypedRpcClient).rpc(
    "claim_csv_import_line_type_lookup",
    {
      p_job_id: args.jobId,
      p_org_id: args.orgId,
      p_phone_e164: args.phone,
    },
  );
  if (error) throw new Error(`line-type lookup claim: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (
    !row ||
    typeof row !== "object" ||
    !["claimed", "reused", "ambiguous", "retry_blocked"].includes(
      String((row as Record<string, unknown>).action),
    )
  ) {
    throw new Error("line-type lookup claim returned an invalid outcome");
  }
  return row as LineTypeClaim;
}

async function completeLineTypeLookup(
  supabase: SupabaseClient<Database>,
  args: {
    jobId: string;
    orgId: string;
    phone: string;
    state: "completed" | "retryable" | "ambiguous";
    lineType: PhoneLineType;
    outcome: string;
    httpStatus: number | null;
    lastError: string | null;
  },
): Promise<void> {
  const { error } = await (supabase as unknown as UntypedRpcClient).rpc(
    "complete_csv_import_line_type_lookup",
    {
      p_job_id: args.jobId,
      p_org_id: args.orgId,
      p_phone_e164: args.phone,
      p_state: args.state,
      p_line_type: args.lineType,
      p_outcome: args.outcome,
      p_provider_http_status: args.httpStatus,
      p_last_error: args.lastError,
    },
  );
  if (error) throw new Error(`line-type lookup checkpoint: ${error.message}`);
}

export async function classifyPhonesWithDurableLedger(
  supabase: SupabaseClient<Database>,
  lookup: Pick<TelnyxLineTypeLookup, "classifyOne">,
  args: { jobId: string; orgId: string; numbers: string[] },
): Promise<[string, PhoneLineType][]> {
  const entries: Array<[string, PhoneLineType] | undefined> = new Array(
    args.numbers.length,
  );
  const failures: string[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= args.numbers.length) return;
      const phone = args.numbers[index];
      try {
        const claim = await claimLineTypeLookup(supabase, {
          jobId: args.jobId,
          orgId: args.orgId,
          phone,
        });
        if (claim.action === "reused") {
          if (
            claim.line_type !== "mobile" &&
            claim.line_type !== "landline" &&
            claim.line_type !== "unknown"
          ) {
            throw new Error(
              "line-type reuse returned an invalid classification",
            );
          }
          entries[index] = [phone, claim.line_type];
          continue;
        }
        if (claim.action !== "claimed") {
          failures.push(claim.action);
          continue;
        }

        const outcome = await lookup.classifyOne(phone);
        await completeLineTypeLookup(supabase, {
          jobId: args.jobId,
          orgId: args.orgId,
          phone,
          state: outcome.status,
          lineType: outcome.lineType,
          outcome: outcome.reason,
          httpStatus: outcome.httpStatus,
          lastError:
            outcome.status === "retryable"
              ? "Telnyx explicitly rejected the lookup after its bounded retry."
              : outcome.status === "ambiguous"
                ? "Telnyx transport outcome is unknown; automatic replay is blocked."
                : null,
        });
        if (outcome.status === "completed") {
          entries[index] = [phone, outcome.lineType];
        } else {
          failures.push(outcome.status);
        }
      } catch {
        // Await every worker before rejecting the step. Returning early from
        // Promise.all would leave paid calls running without waiting for their
        // durable checkpoints.
        failures.push("checkpoint_error");
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(LINE_TYPE_LEDGER_WORKERS, args.numbers.length) },
      () => worker(),
    ),
  );
  if (failures.length > 0) {
    throw new Error(
      `Line-type classification stopped with ${failures.length} safely checkpointed provider outcome(s).`,
    );
  }
  return entries.filter(
    (entry): entry is [string, PhoneLineType] => entry !== undefined,
  );
}

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
  /** Server-derived organization boundary. Never accepted from the browser. */
  orgId: string;
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
  requestCass?: boolean;
  /** Disabled until a verified provider price and workflow handoff exist. */
  requestSkipTrace?: boolean;
  datasetSha256: string;
  reviewContractSha256: string;
  datasetVersion: number;
  expectedTotalRows: number;
  expectedDncRows: number;
  listName?: string | null;
  listResolutionError?: string | null;
};

export type EnrollBatchResult = {
  enrolled: number;
  skipped: number;
  failed: number;
};

async function recoverCountyStep(args: {
  jobId: string;
  csvImportId: string;
  orgId: string;
  expectedCountyId: string | null;
  storagePath: string;
  source: string;
  market: string;
  datasetSha256: string;
}): Promise<string> {
  "use step";

  const supabase = createAdminClient();
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id, org_id, type, related_import_id")
    .eq("id", args.jobId)
    .eq("org_id", args.orgId)
    .eq("type", "csv_import")
    .eq("related_import_id", args.csvImportId)
    .maybeSingle();
  if (jobError || !job) {
    throw new Error(
      `import job recovery: ${jobError?.message ?? "job identity mismatch"}`,
    );
  }
  const { data: row, error } = await supabase
    .from("csv_imports")
    .select("county_id, storage_path, source, market, dataset_sha256")
    .eq("id", args.csvImportId)
    .eq("org_id", args.orgId)
    .maybeSingle();
  if (error || !row?.county_id) {
    throw new Error(
      `import county recovery: ${error?.message ?? "county is missing"}`,
    );
  }
  if (
    (args.expectedCountyId !== null &&
      row.county_id !== args.expectedCountyId) ||
    row.storage_path !== args.storagePath ||
    row.source !== args.source ||
    row.market !== args.market ||
    row.dataset_sha256 !== args.datasetSha256 ||
    !row.storage_path?.startsWith(`${args.orgId}/`)
  ) {
    throw new Error("import recovery: authoritative provenance mismatch");
  }
  return row.county_id;
}

async function failCsvImportWorkflowStep(args: {
  jobId: string;
  csvImportId: string;
  orgId: string;
  message: string;
}): Promise<void> {
  "use step";
  const supabase = createAdminClient();
  const { error } = await supabase.rpc("fail_csv_import_workflow", {
    p_job_id: args.jobId,
    p_csv_import_id: args.csvImportId,
    p_org_id: args.orgId,
    p_message: args.message,
  });
  if (error) throw new Error(`CSV import failure checkpoint: ${error.message}`);
}

/**
 * Enroll every succeeded job_item's property into the given sequence.
 * Outcomes: "enrolled" → enrolled, "failed" → failed, anything else → skipped.
 * Never throws — partial failures are counted and execution continues.
 */
export async function enrollJobBatch(
  supabase: SupabaseClient<Database>,
  args: { jobId: string; sequenceId: string; orgId: string },
): Promise<EnrollBatchResult> {
  const eligibleItemPropertyIds = new Set<string>();
  let lastItemId: string | null = null;
  for (;;) {
    let query = supabase
      .from("job_items")
      .select("id, property_id, compliance_locked")
      .eq("job_id", args.jobId)
      .in("status", ["success", "skipped"])
      .order("id", { ascending: true })
      .limit(SEQUENCE_ITEM_PAGE_SIZE);
    if (lastItemId) query = query.gt("id", lastItemId);
    const { data: items, error: itemsError } = await query;
    if (itemsError) {
      throw new Error(`sequence checkpoint read: ${itemsError.message}`);
    }
    for (const item of items ?? []) {
      lastItemId = item.id;
      if (!item.compliance_locked && item.property_id) {
        eligibleItemPropertyIds.add(item.property_id);
      }
    }
    if (!items || items.length < SEQUENCE_ITEM_PAGE_SIZE) break;
  }

  const propertyIds = await selectNonDncPropertyIds(
    supabase,
    [...eligibleItemPropertyIds],
    args.orgId,
  );

  let enrolled = 0;
  let skipped = 0;
  let failed = 0;
  const enrolledRows: Array<{
    propertyId: string;
    enrollmentId: string;
    sequenceLabel: string;
  }> = [];

  for (const propertyId of propertyIds) {
    try {
      const outcome = await enrollLead(supabase, {
        sequenceId: args.sequenceId,
        propertyId,
        deferEvent: true,
      });
      if (outcome.status === "enrolled") {
        enrolled++;
        enrolledRows.push({
          propertyId,
          enrollmentId: outcome.enrollmentId,
          sequenceLabel: outcome.sequenceLabel,
        });
      } else if (
        outcome.status === "failed" ||
        outcome.status === "sequence_not_found" ||
        outcome.status === "sequence_inactive" ||
        outcome.status === "property_not_found" ||
        outcome.status === "no_steps"
      )
        failed++;
      else skipped++;
    } catch {
      failed++;
    }
  }

  if (enrolled + skipped + failed !== propertyIds.length) {
    throw new Error("sequence enrollment count conservation failed");
  }

  if (enrolledRows.length > 0) {
    const batchId = crypto.randomUUID();
    await recordLeadEvents(
      enrolledRows.map((row) => ({
        propertyId: row.propertyId,
        actorType: "system" as const,
        eventType: LEAD_EVENT_TYPES.SEQUENCE_ENROLLED,
        payload: {
          enrollment_id: row.enrollmentId,
          sequence_id: args.sequenceId,
          label: row.sequenceLabel,
          batch_id: batchId,
          batch_count: enrolledRows.length,
        },
        sourceType: "sequence_enrollments.created",
        sourceId: row.enrollmentId,
      })),
    );
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
  expectedSha256: string,
  expectedDncRows: number,
  orgId: string,
  expectedReviewContractSha256: string,
  reviewContract: ReviewContractInput,
): Promise<{
  rows: RowData[];
  totalRows: number;
  autoTagIds: string[];
  dncRows: number;
}> {
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
  const actualSha256 = createHash("sha256").update(text).digest("hex");
  if (actualSha256 !== expectedSha256) {
    const { error: checksumFailureError } = await supabase
      .from("jobs")
      .update({
        status: "failed",
        error_class: "validation",
        error_message:
          "Stored dataset does not match the reviewed dataset checksum. Nothing was imported.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (checksumFailureError) {
      throw new Error(
        `dataset checksum failure checkpoint: ${checksumFailureError.message}`,
      );
    }
    throw new Error("reviewed dataset checksum mismatch");
  }
  const actualReviewContractSha256 = createHash("sha256")
    .update(
      reviewContractJson({ ...reviewContract, datasetSha256: actualSha256 }),
    )
    .digest("hex");
  if (actualReviewContractSha256 !== expectedReviewContractSha256) {
    const { error: contractFailureError } = await supabase
      .from("jobs")
      .update({
        status: "failed",
        error_class: "validation",
        error_message:
          "The reviewed mapping or confirmation choices changed. Nothing was imported.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (contractFailureError) {
      throw new Error(
        `review contract failure checkpoint: ${contractFailureError.message}`,
      );
    }
    throw new Error("review contract checksum mismatch");
  }
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: false,
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
  if (trimmedRows.length !== reviewContract.totalRows) {
    const { error: rowCountFailureError } = await supabase
      .from("jobs")
      .update({
        status: "failed",
        error_class: "validation",
        error_message: "The reviewed row count changed. Nothing was imported.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (rowCountFailureError) {
      throw new Error(
        `row-count failure checkpoint: ${rowCountFailureError.message}`,
      );
    }
    throw new Error("reviewed dataset row-count mismatch");
  }
  const dncRows = trimmedRows.reduce(
    (count, row, index) =>
      validateRow(row, mapping, index).normalized.homeowner_do_not_contact ===
      true
        ? count + 1
        : count,
    0,
  );
  if (dncRows !== expectedDncRows) {
    const { error: dncFailureError } = await supabase
      .from("jobs")
      .update({
        status: "failed",
        error_class: "validation",
        error_message:
          "DNC count changed between preflight and ingest. Nothing was imported.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (dncFailureError) {
      throw new Error(`DNC failure checkpoint: ${dncFailureError.message}`);
    }
    throw new Error("DNC conservation check failed");
  }

  const { autoTagIds } = await prepareIngestion(supabase, {
    jobId,
    totalRows: trimmedRows.length,
    source,
    orgId,
  });

  return {
    rows: trimmedRows,
    totalRows: trimmedRows.length,
    autoTagIds,
    dncRows,
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

  const eligibleRows = args.rows.filter(
    (row, index) =>
      validateRow(row, args.mapping, index).normalized
        .homeowner_do_not_contact !== true,
  );

  return {
    numbers: collectUnlabeledPhones(eligibleRows, args.mapping),
    telnyxConfigured: !!process.env.TELNYX_API_KEY?.trim(),
  };
}

/**
 * STEP 1c — Classify one slice of phone numbers via Telnyx. Returns
 * entries (not a Map — step results must serialize). Per-number claims and
 * results are durable across whole-workflow retries. This paid step disables
 * WDK's automatic retry; only the job's persisted retry policy can authorize
 * another explicitly rejected lookup.
 */
async function classifyPhonesChunkStep(args: {
  jobId: string;
  orgId: string;
  numbers: string[];
}): Promise<[string, PhoneLineType][]> {
  "use step";

  const supabase = createAdminClient();
  const lookup = telnyxLookupFromEnv();
  return classifyPhonesWithDurableLedger(supabase, lookup, args);
}

Object.assign(classifyPhonesChunkStep, { maxRetries: 0 });

/**
 * Mark the job failed with an operator-readable error. Used when the
 * operator approved paid classification but the lookup can't run —
 * failing fast beats silently dropping the numbers they paid to keep.
 */
async function failJobStep(args: {
  jobId: string;
  orgId: string;
  message: string;
  errorClass: "validation" | "configuration";
}): Promise<void> {
  "use step";

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("jobs")
    .update({
      status: "failed",
      error_class: args.errorClass,
      error_message: args.message,
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.jobId)
    .eq("org_id", args.orgId);
  if (error) throw new Error(`job failure checkpoint: ${error.message}`);
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
  orgId: string;
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
    orgId: args.orgId,
    mapping: args.mapping,
    rows: args.rows,
    offset: args.offset,
    autoTagIds: args.autoTagIds,
    listId: args.listId,
    userId: args.userId,
    priorSucceeded: args.priorSucceeded,
    priorFailed: args.priorFailed,
    resumeSafe: true,
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
  orgId: string;
}): Promise<{
  status: "completed" | "pending" | "failed";
  eligible: number;
  message?: string;
}> {
  "use step";

  const supabase = createAdminClient();

  const propertyIds = await selectNonDncPropertyIds(
    supabase,
    await excludeComplianceLockedJobProperties(
      supabase,
      args.parentJobId,
      await selectCassEligibleProperties(
        supabase,
        args.parentJobId,
        args.orgId,
      ),
    ),
    args.orgId,
  );

  if (propertyIds.length === 0) return { status: "completed", eligible: 0 };

  const cap = getAutotriggerCap();
  const autoStart = propertyIds.length <= cap;
  const child = await createCassChildJob(supabase, {
    parentJobId: args.parentJobId,
    relatedImportId: args.relatedImportId,
    createdBy: args.createdBy,
    orgId: args.orgId,
    propertyIds,
    autoStart,
    blockedReason: autoStart
      ? undefined
      : `${propertyIds.length} items exceeds CASS_AUTOTRIGGER_MAX_ITEMS=${cap}`,
    requestKey: args.parentJobId,
  });

  if (autoStart) {
    if (child.status !== "running") {
      return {
        status: child.status === "completed" ? "completed" : "failed",
        eligible: propertyIds.length,
        message:
          child.status === "completed"
            ? undefined
            : `Existing CASS job is ${child.status}; use its explicit retry or review path.`,
      };
    }
    const summary = await runCassEnrichment(supabase, {
      jobId: child.jobId,
      propertyIds,
      expectedOrgId: args.orgId,
      claimToken: child.claimToken,
    });
    if (summary.failed > 0 || summary.providerOff > 0) {
      return {
        status: "failed",
        eligible: propertyIds.length,
        message:
          `${summary.failed} address verification failures; ` +
          `${summary.providerOff} skipped because the provider was unavailable.`,
      };
    }
  }
  return {
    status: autoStart ? "completed" : "pending",
    eligible: propertyIds.length,
  };
}

/**
 * STEP 3b — Bulk-record opt_in_marketing_written for every homeowner contact
 * linked to a succeeded row in this import. Fires only when the operator
 * checked the SMS consent attestation box on the confirm screen.
 *
 * The database RPC validates immutable job provenance, rechecks compliance,
 * and inserts each job/contact attestation once across workflow retries.
 */
async function recordConsentStep(args: {
  jobId: string;
  orgId: string;
}): Promise<void> {
  "use step";

  const supabase = createAdminClient();
  const { error: consentError } = await supabase.rpc(
    "record_csv_import_consents",
    { p_job_id: args.jobId, p_org_id: args.orgId },
  );
  if (consentError)
    throw new Error(`consent recording: ${consentError.message}`);
}

async function selectNonDncPropertyIds(
  supabase: SupabaseClient<Database>,
  propertyIds: string[],
  orgId: string,
): Promise<string[]> {
  if (propertyIds.length === 0) return [];
  const data: Array<{
    id: string;
    outreach_dispo: string | null;
    homeowner:
      | {
          phone_1: string | null;
          phone_2: string | null;
          phone_3: string | null;
          do_not_contact: boolean;
          sms_opted_out: boolean;
        }
      | {
          phone_1: string | null;
          phone_2: string | null;
          phone_3: string | null;
          do_not_contact: boolean;
          sms_opted_out: boolean;
        }[]
      | null;
  }> = [];
  for (
    let offset = 0;
    offset < propertyIds.length;
    offset += POSTGREST_IN_CHUNK_SIZE
  ) {
    const ids = propertyIds.slice(offset, offset + POSTGREST_IN_CHUNK_SIZE);
    const { data: page, error } = await supabase
      .from("properties")
      .select(
        "id, outreach_dispo, homeowner:contacts!properties_homeowner_contact_id_fkey(phone_1, phone_2, phone_3, do_not_contact, sms_opted_out)",
      )
      .in("id", ids)
      .eq("org_id", orgId);
    if (error) throw new Error(`DNC eligibility check: ${error.message}`);
    if (page) data.push(...page);
  }

  const phones = (data ?? []).flatMap((property) => {
    const homeowner = Array.isArray(property.homeowner)
      ? property.homeowner[0]
      : property.homeowner;
    return homeowner
      ? [homeowner.phone_1, homeowner.phone_2, homeowner.phone_3].filter(
          (phone): phone is string => !!phone,
        )
      : [];
  });
  const suppressed: Array<{ phone_e164: string }> = [];
  const distinctPhones = [...new Set(phones)];
  for (
    let offset = 0;
    offset < distinctPhones.length;
    offset += POSTGREST_IN_CHUNK_SIZE
  ) {
    const phonePage = distinctPhones.slice(
      offset,
      offset + POSTGREST_IN_CHUNK_SIZE,
    );
    const { data: suppressionPage, error: suppressionError } = await supabase
      .from("sms_phone_suppressions")
      .select("phone_e164")
      .eq("org_id", orgId)
      .eq("channel", "sms")
      .in("phone_e164", phonePage);
    if (suppressionError) {
      throw new Error(`DNC suppression check: ${suppressionError.message}`);
    }
    if (suppressionPage) suppressed.push(...suppressionPage);
  }
  const suppressedPhones = new Set(suppressed.map((row) => row.phone_e164));

  return data
    .filter((property) => {
      const homeowner = Array.isArray(property.homeowner)
        ? property.homeowner[0]
        : property.homeowner;
      if (
        property.outreach_dispo &&
        SUPPRESSED_DISPOS.has(property.outreach_dispo as "dnc")
      ) {
        return false;
      }
      if (homeowner?.do_not_contact || homeowner?.sms_opted_out) return false;
      return ![homeowner?.phone_1, homeowner?.phone_2, homeowner?.phone_3].some(
        (phone) => phone && suppressedPhones.has(phone),
      );
    })
    .map((property) => property.id);
}

async function excludeComplianceLockedJobProperties(
  supabase: SupabaseClient<Database>,
  jobId: string,
  propertyIds: string[],
): Promise<string[]> {
  if (propertyIds.length === 0) return [];
  const locked = new Set<string>();
  let lastItemId: string | null = null;
  for (;;) {
    let query = supabase
      .from("job_items")
      .select("id, property_id")
      .eq("job_id", jobId)
      .eq("compliance_locked", true)
      .not("property_id", "is", null)
      .order("id", { ascending: true })
      .limit(SEQUENCE_ITEM_PAGE_SIZE);
    if (lastItemId) query = query.gt("id", lastItemId);
    const { data, error } = await query;
    if (error)
      throw new Error(`DNC job-item eligibility check: ${error.message}`);
    for (const item of data ?? []) {
      if (item.property_id) locked.add(item.property_id);
    }
    if (!data || data.length < SEQUENCE_ITEM_PAGE_SIZE) break;
    lastItemId = data.at(-1)?.id ?? null;
    if (!lastItemId) throw new Error("DNC job-item page had no cursor");
  }
  return propertyIds.filter((propertyId) => !locked.has(propertyId));
}

/**
 * STEP 3b — Auto-enroll every succeeded import item into a sequence.
 * Fires only when the operator selected a sequence on the confirm screen.
 */
async function enrollInSequenceStep(args: {
  jobId: string;
  sequenceId: string;
  orgId: string;
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
  orgId: string;
  totalRows: number;
  succeeded: number;
  failed: number;
  skipped: number;
  droppedUnlabeledPhones: number;
  lineTypeClassification: ClassificationCounts | null;
  dncRows: number;
  sideEffects: ImportSideEffects;
  errors: { rowIndex: number; message: string }[];
}): Promise<void> {
  "use step";

  const supabase = createAdminClient();
  await finalizeIngestion(supabase, args);
}

async function loadPriorSideEffectsStep(
  jobId: string,
  orgId: string,
): Promise<ImportSideEffects> {
  "use step";
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("result_summary")
    .eq("id", jobId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`side-effect checkpoint read: ${error.message}`);
  const summary = (data?.result_summary ?? {}) as Record<string, unknown>;
  return (summary.sideEffects ?? {}) as ImportSideEffects;
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

  try {
    if (params.datasetVersion !== REVIEWED_DATASET_VERSION) {
      await failJobStep({
        jobId: params.jobId,
        orgId: params.orgId,
        errorClass: "validation",
        message:
          "This reviewed dataset version is no longer supported. Run preflight again.",
      });
      return { succeeded: 0, failed: 0, skipped: 0, totalRows: 0 };
    }
    const unavailableService = [
      params.requestCass ? IMPORT_SERVICE_PRICING.cass : null,
      params.classifyLineTypes ? IMPORT_SERVICE_PRICING.line_type : null,
      params.requestSkipTrace ? IMPORT_SERVICE_PRICING.skip_trace : null,
    ].find((service) => service && !service.configured);
    if (unavailableService) {
      await failJobStep({
        jobId: params.jobId,
        orgId: params.orgId,
        errorClass: "configuration",
        message:
          unavailableService.unavailableReason ??
          `${unavailableService.label} is unavailable during import.`,
      });
      return { succeeded: 0, failed: 0, skipped: 0, totalRows: 0 };
    }

    // This step validates the complete job/import tenant identity even for
    // modern jobs that already carry countyId. Legacy jobs recover countyId
    // from the same authoritative row without doing DB I/O in the workflow VM.
    const countyId = await recoverCountyStep({
      jobId: params.jobId,
      csvImportId: params.csvImportId,
      orgId: params.orgId,
      expectedCountyId: params.countyId,
      storagePath: params.storagePath,
      source: params.source,
      market: params.market,
      datasetSha256: params.datasetSha256,
    });

    const loaded = await loadCsvFromStorage(
      params.storagePath,
      params.mapping,
      params.jobId,
      params.source,
      params.datasetSha256,
      params.expectedDncRows,
      params.orgId,
      params.reviewContractSha256,
      {
        datasetSha256: params.datasetSha256,
        mapping: params.mapping,
        source: params.source,
        countyId,
        totalRows: params.expectedTotalRows,
        dncRows: params.expectedDncRows,
        smsConsent: params.smsConsent === true,
        sequenceId: params.sequenceId ?? null,
        classifyLineTypes: params.classifyLineTypes === true,
        requestCass: params.requestCass === true,
        requestSkipTrace: params.requestSkipTrace === true,
      },
    );

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
          orgId: params.orgId,
          errorClass: "configuration",
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
          entries.push(
            ...(await classifyPhonesChunkStep({
              jobId: params.jobId,
              orgId: params.orgId,
              numbers: slice,
            })),
          );
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
        orgId: params.orgId,
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

    const priorSideEffects = await loadPriorSideEffectsStep(
      params.jobId,
      params.orgId,
    );
    const sideEffects: ImportSideEffects = {
      listAssignment: params.listName
        ? params.listResolutionError
          ? { status: "failed", message: params.listResolutionError }
          : { status: "completed" }
        : { status: "not_requested" },
      cass: { status: "not_requested" },
      lineTypeClassification: params.classifyLineTypes
        ? { status: "completed", counts: lineTypeClassification }
        : { status: "not_requested" },
      consent: { status: "not_requested" },
      sequenceEnrollment: { status: "not_requested" },
      skipTrace: { status: "not_requested" },
      ...priorSideEffects,
    };

    if (params.requestCass && priorSideEffects.cass?.status !== "completed") {
      try {
        sideEffects.cass = await triggerCassStep({
          parentJobId: params.jobId,
          relatedImportId: params.csvImportId,
          createdBy: params.userId,
          orgId: params.orgId,
        });
      } catch (error) {
        sideEffects.cass = {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (params.smsConsent && priorSideEffects.consent?.status !== "completed") {
      try {
        await recordConsentStep({ jobId: params.jobId, orgId: params.orgId });
        sideEffects.consent = { status: "completed" };
      } catch (error) {
        sideEffects.consent = {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (
      params.sequenceId &&
      priorSideEffects.sequenceEnrollment?.status !== "completed"
    ) {
      const enrollment = await enrollInSequenceStep({
        jobId: params.jobId,
        sequenceId: params.sequenceId,
        orgId: params.orgId,
      });
      sideEffects.sequenceEnrollment = {
        status: enrollment.failed > 0 ? "failed" : "completed",
        ...enrollment,
      };
    }

    await finalizeStep({
      jobId: params.jobId,
      csvImportId: params.csvImportId,
      orgId: params.orgId,
      totalRows: loaded.totalRows,
      succeeded,
      failed,
      skipped,
      droppedUnlabeledPhones,
      lineTypeClassification,
      dncRows: loaded.dncRows,
      sideEffects,
      errors: allErrors,
    });

    return {
      succeeded,
      failed,
      skipped,
      totalRows: loaded.totalRows,
    };
  } catch (error) {
    await failCsvImportWorkflowStep({
      jobId: params.jobId,
      csvImportId: params.csvImportId,
      orgId: params.orgId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
