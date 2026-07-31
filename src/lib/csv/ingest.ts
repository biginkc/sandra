import type { SupabaseClient } from "@supabase/supabase-js";

import { asLineType, type PhoneLineType } from "@/lib/messaging/line-type";
import type { Database, Json } from "@/lib/supabase/types";
import { resolveFips } from "./fips";
import { normalizeAddress, normalizeDisplayAddress, normalizeName } from "./normalize";
import { validateRow, type Mapping, type RowData } from "./validate";

type PropertyInsert = Database["public"]["Tables"]["properties"]["Insert"];
type ContactInsert = Database["public"]["Tables"]["contacts"]["Insert"];

function rowToJson(row: RowData): Json {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v == null ? null : String(v);
  }
  return out;
}

export type IngestParams = {
  jobId: string;
  csvImportId: string;
  source: string;
  market: string;
  /** county_id (FK to counties.id) chosen on the wizard's market dropdown
   *  and threaded down from the workflow boundary. Per phase 02 D-04 it
   *  is set in lockstep with `properties.market` at insert time. Nullable
   *  for the legacy runIngestion path that does not yet thread it. */
  countyId?: string | null;
  mapping: Mapping;
  rows: RowData[];
  /** Optional: add every ingested (or dedup-matched) property to this list. */
  listId?: string | null;
  /** Current user, stamped onto property_lists.last_added_by when listId set. */
  userId?: string | null;
};

export type IngestSummary = {
  succeeded: number;
  failed: number;
  skipped: number;
  /** Phones dropped at ingest because they arrived with no line type
   *  (the migration-080 hard rule: unlabeled numbers are never saved). */
  droppedUnlabeledPhones: number;
  errors: { rowIndex: number; message: string }[];
};

/**
 * Per-chunk parameters used by the workflow runner. The workflow body loops
 * `processIngestChunk()` calls in fixed-size offsets so each invocation
 * stays well under the serverless function timeout. Auto-tags are resolved
 * once in `prepareIngestion()` and threaded through every chunk so we don't
 * re-resolve them per row.
 */
export type ProcessChunkParams = {
  jobId: string;
  csvImportId: string;
  source: string;
  market: string;
  /** county_id from the workflow boundary (D-04). Threaded into ingestRow
   *  so the property insert sets `county_id` alongside `market`. Null is
   *  legal — legacy callers / runIngestion path don't always provide it. */
  countyId?: string | null;
  mapping: Mapping;
  /** The rows for THIS chunk only. Caller is responsible for slicing. */
  rows: RowData[];
  /** The 0-based offset of `rows[0]` within the full CSV — used for progress
   *  reporting and the `rowIndex` in error samples. */
  offset: number;
  autoTagIds: string[];
  listId?: string | null;
  userId?: string | null;
  /**
   * Running totals from prior chunks. The chunk includes these when it
   * writes progress to `jobs` so the UI's live counters reflect the whole
   * job's progress, not just this chunk's slice. Default 0 — appropriate
   * for the legacy single-chunk runIngestion() path.
   */
  priorSucceeded?: number;
  priorFailed?: number;
};

export type ChunkResult = {
  succeeded: number;
  failed: number;
  skipped: number;
  /** Phones dropped in this chunk because they had no line type. */
  droppedUnlabeledPhones: number;
  errors: { rowIndex: number; message: string }[];
};

const PROGRESS_UPDATE_INTERVAL = 10;
const ERROR_SAMPLE_SIZE = 20;

/**
 * As of migration 030, the import wizard's source picker uses the same
 * canonical enum as the DB column (`src/lib/leads/create.ts → LEAD_SOURCES`)
 * — no translation table needed. Column mapping is handled by
 * `aliases.ts` autodetect, so source is purely an attribution signal
 * the user picks deliberately. The previous `VENDOR_DEFAULT_SOURCE`
 * heuristic (dealmachine→driving_for_dollars, zillow→mls, etc.) is
 * retired with this migration.
 */

/**
 * Runs the full ingestion in one call. Backward-compatible wrapper for
 * call sites (and integration tests) that haven't moved to the chunked
 * workflow runner yet. New callers should use the workflow at
 * `src/workflows/csv-import.ts`, which composes prepare → loop
 * processIngestChunk → finalize directly so each step stays under the
 * serverless function timeout.
 */
export async function runIngestion(
  supabase: SupabaseClient<Database>,
  params: IngestParams,
): Promise<IngestSummary> {
  const { autoTagIds } = await prepareIngestion(supabase, {
    jobId: params.jobId,
    totalRows: params.rows.length,
    source: params.source,
  });

  const chunk = await processIngestChunk(supabase, {
    jobId: params.jobId,
    csvImportId: params.csvImportId,
    source: params.source,
    market: params.market,
    countyId: params.countyId ?? null,
    mapping: params.mapping,
    rows: params.rows,
    offset: 0,
    autoTagIds,
    listId: params.listId ?? null,
    userId: params.userId ?? null,
  });

  await finalizeIngestion(supabase, {
    jobId: params.jobId,
    csvImportId: params.csvImportId,
    totalRows: params.rows.length,
    succeeded: chunk.succeeded,
    failed: chunk.failed,
    skipped: chunk.skipped,
    droppedUnlabeledPhones: chunk.droppedUnlabeledPhones,
    errors: chunk.errors,
  });

  return {
    succeeded: chunk.succeeded,
    failed: chunk.failed,
    skipped: chunk.skipped,
    droppedUnlabeledPhones: chunk.droppedUnlabeledPhones,
    errors: chunk.errors,
  };
}

/**
 * One-time setup before any chunk runs. Sets the job to running, stamps
 * total_items + started_at, and resolves the two auto-applied tag ids
 * (source:vendor and uploaded:YYYY-MM) so the per-row loop doesn't have
 * to re-resolve them on every chunk.
 */
export async function prepareIngestion(
  supabase: SupabaseClient<Database>,
  params: { jobId: string; totalRows: number; source: string },
): Promise<{ autoTagIds: string[] }> {
  await supabase
    .from("jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      total_items: params.totalRows,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", params.jobId);

  const autoTagIds = await resolveAutoTagIds(supabase, params.source);
  return { autoTagIds };
}

/**
 * Process one slice of pre-parsed CSV rows. Designed to run inside a
 * Workflow DevKit "use step" so it gets retried on transient failure and
 * its result is persisted for replay. The caller (the workflow body)
 * picks chunk size based on per-row latency vs the function timeout —
 * 250 rows fits comfortably under Vercel Pro's 5-minute cap with
 * generous headroom even on slow CASS lookups.
 *
 * Pure function of (params): no global state, no auto-tag resolution
 * (caller threads in `autoTagIds`), no jobs.status mutation (the workflow
 * sets running/completed/partial/failed at the boundaries). The only
 * job-row writes are progress + heartbeat updates so the wizard's
 * Realtime subscription stays live throughout.
 *
 * `errors` is a sample, not the full list — caller appends to its
 * accumulator and trims to ERROR_SAMPLE_SIZE before writing the final
 * `jobs.result_summary`.
 */
export async function processIngestChunk(
  supabase: SupabaseClient<Database>,
  params: ProcessChunkParams,
): Promise<ChunkResult> {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let droppedUnlabeledPhones = 0;
  const errors: { rowIndex: number; message: string }[] = [];

  for (let localIndex = 0; localIndex < params.rows.length; localIndex++) {
    const absoluteIndex = params.offset + localIndex;
    const row = params.rows[localIndex];
    const validated = validateRow(row, params.mapping, absoluteIndex);

    // Empty row — skip silently
    if (Object.keys(validated.normalized).length === 0) {
      skipped++;
      continue;
    }

    if (!validated.ok) {
      const msg = validated.errors[0]?.message ?? "Validation failed";
      await supabase.from("job_items").insert({
        job_id: params.jobId,
        status: "error",
        error_message: msg,
        error_class: "validation",
        input_payload: rowToJson(row),
      });
      failed++;
      if (errors.length < ERROR_SAMPLE_SIZE)
        errors.push({ rowIndex: absoluteIndex, message: msg });
      continue;
    }

    try {
      const result = await ingestRow(
        supabase,
        validated.normalized,
        params.source,
        params.market,
        params.countyId ?? null,
      );
      droppedUnlabeledPhones += result.droppedUnlabeledPhones;

      // Stacking: every ingested row — including dedup-matched ones —
      // gets added to the import's list (if one was selected). Re-importing
      // the same address into a different list is exactly how stacking
      // accumulates signal on a high-motivation lead.
      if (params.listId) {
        await upsertPropertyListMembership(supabase, {
          propertyId: result.propertyId,
          listId: params.listId,
          userId: params.userId ?? null,
          csvImportId: params.csvImportId,
        });
      }

      // Auto-apply source + uploaded tags (resolved once in prepareIngestion).
      // Same dedup semantics as list stacking: re-importing a duplicate
      // refreshes the last-touched timestamp via ON CONFLICT DO NOTHING.
      for (const tagId of params.autoTagIds) {
        await supabase.from("property_tags").upsert(
          {
            property_id: result.propertyId,
            tag_id: tagId,
            source: "import",
          },
          { onConflict: "property_id,tag_id", ignoreDuplicates: true },
        );
      }

      await supabase.from("job_items").insert({
        job_id: params.jobId,
        property_id: result.propertyId,
        status: result.wasDuplicate ? "skipped" : "success",
      });
      if (result.wasDuplicate) skipped++;
      else succeeded++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await supabase.from("job_items").insert({
        job_id: params.jobId,
        status: "error",
        error_message: message,
        error_class: "database",
        input_payload: rowToJson(row),
      });
      failed++;
      if (errors.length < ERROR_SAMPLE_SIZE)
        errors.push({ rowIndex: absoluteIndex, message });
    }

    // Progress update every N rows AND on the chunk's final row, so the
    // wizard sees movement even if a chunk happens to be small. Includes
    // cumulative succeeded/failed (chunk's running totals + prior chunks'
    // totals) so the UI's live counters reflect the whole job's progress
    // — fixes the bug where mid-flight Progress showed "all skipped"
    // until finalize wrote the final numbers.
    const isLastInChunk = localIndex === params.rows.length - 1;
    if ((absoluteIndex + 1) % PROGRESS_UPDATE_INTERVAL === 0 || isLastInChunk) {
      await supabase
        .from("jobs")
        .update({
          processed_items: absoluteIndex + 1,
          succeeded_items: (params.priorSucceeded ?? 0) + succeeded,
          failed_items: (params.priorFailed ?? 0) + failed,
          worker_heartbeat_at: new Date().toISOString(),
        })
        .eq("id", params.jobId);
    }
  }

  return { succeeded, failed, skipped, droppedUnlabeledPhones, errors };
}

/**
 * Mark the job + csv_imports as terminal. Called once after the last
 * chunk completes (or, in the legacy `runIngestion` path, immediately
 * after the single chunk). Status is `completed` when nothing failed,
 * `partial` when at least one row succeeded but some failed, `failed`
 * when zero succeeded.
 */
export async function finalizeIngestion(
  supabase: SupabaseClient<Database>,
  params: {
    jobId: string;
    csvImportId: string;
    totalRows: number;
    succeeded: number;
    failed: number;
    skipped: number;
    /** Total unlabeled phones dropped across all chunks. Optional so the
     *  legacy single-shot path and older callers don't have to thread it. */
    droppedUnlabeledPhones?: number;
    /** Telnyx classification counts from the workflow's pre-ingest step.
     *  Null/absent when classification didn't run for this import. */
    lineTypeClassification?: {
      classifiedMobile: number;
      classifiedLandline: number;
      stillUnknown: number;
      estimatedCostUsd: number;
    } | null;
    errors: { rowIndex: number; message: string }[];
  },
): Promise<void> {
  const status: Database["public"]["Tables"]["jobs"]["Update"]["status"] =
    params.failed === 0 && params.totalRows > 0
      ? "completed"
      : params.succeeded > 0
        ? "partial"
        : "failed";

  await supabase
    .from("jobs")
    .update({
      status,
      processed_items: params.totalRows,
      succeeded_items: params.succeeded,
      failed_items: params.failed,
      completed_at: new Date().toISOString(),
      result_summary: {
        succeeded: params.succeeded,
        failed: params.failed,
        skipped: params.skipped,
        droppedUnlabeledPhones: params.droppedUnlabeledPhones ?? 0,
        lineTypeClassification: params.lineTypeClassification ?? null,
        errors: params.errors.slice(0, ERROR_SAMPLE_SIZE),
      },
    })
    .eq("id", params.jobId);

  await supabase
    .from("csv_imports")
    .update({
      inserted_properties: params.succeeded,
      skipped_duplicates: params.skipped,
      failed_rows: params.failed,
      total_rows: params.totalRows,
    })
    .eq("id", params.csvImportId);
}

// ---------- per-row ingestion ----------

async function ingestRow(
  supabase: SupabaseClient<Database>,
  n: Readonly<Record<string, unknown>>,
  defaultSource: string,
  market: string,
  countyId: string | null,
): Promise<{
  propertyId: string;
  wasDuplicate: boolean;
  droppedUnlabeledPhones: number;
}> {
  const addressRaw = n.address as string | null;
  if (!addressRaw) throw new Error("Address is required");

  const addressNormalized = normalizeAddress(addressRaw);
  const state = n.state as string | null;
  if (!state) throw new Error("State is required");

  const fipsCode = await resolveFips(supabase, {
    state,
    countyName: n.county_name as string | null,
    zip: n.zip as string | null,
  });

  // Hard rule (migration 080): a phone with no line type is never saved.
  // Drop unlabeled slots up front and compact typed phones forward; the
  // contact itself still upserts (name/email survive) even when every
  // phone was dropped.
  const phoneSlots = compactTypedPhones(n);

  // Upsert homeowner contact + sidecar when any homeowner fields are present.
  let homeownerContactId: string | null = null;
  if (hasHomeownerFields(n)) {
    // A DNC-flagged row must be able to match an existing contact via a
    // phone that compactTypedPhones() just dropped (a DNC label normalizes
    // to 'unknown' and is never written to a slot) — otherwise a row whose
    // only identifier is the DNC-labeled phone can never find the contact
    // it's supposed to suppress (Codex PR #310 finding 1). Scoped to
    // DNC-flagged rows only: an ordinary row that merely lacks a line-type
    // mapping (no compliance signal at all) keeps the existing phone_1-only
    // match semantics — widening matching for every unlabeled-phone drop is
    // a bigger, unrelated behavior change this PR isn't making.
    const isDncRow =
      (n.homeowner_do_not_contact as boolean | null) === true;
    const primaryPhone = phoneSlots.contactFields.phone_1;
    // Unchanged from before this PR: match on phone_1 only, same field the
    // old single-phone check used — this branch must not silently start
    // matching on phone_2/phone_3, which is a separate, bigger behavior
    // change this PR isn't making.
    const matchPhones = isDncRow
      ? [
          ...new Set(
            [primaryPhone, ...phoneSlots.droppedPhones].filter(
              (p): p is string => !!p,
            ),
          ),
        ]
      : primaryPhone
        ? [primaryPhone]
        : [];
    homeownerContactId = await upsertContact(
      supabase,
      {
        contact_type: deriveHomeownerContactType(n),
        first_name: normalizeName(n.homeowner_first_name as string | null),
        last_name: normalizeName(n.homeowner_last_name as string | null),
        entity_name: normalizeName(n.homeowner_entity_name as string | null),
        ...phoneSlots.contactFields,
        email: (n.homeowner_email as string | null)?.trim().toLowerCase() ?? null,
        do_not_contact:
          (n.homeowner_do_not_contact as boolean | null) ?? undefined,
      },
      matchPhones,
    );
    await supabase
      .from("homeowner_details")
      .upsert(
        {
          contact_id: homeownerContactId,
          mailing_address: normalizeDisplayAddress(n.homeowner_mailing_address as string | null),
          mailing_city: normalizeDisplayAddress(n.homeowner_mailing_city as string | null),
          mailing_state: (n.homeowner_mailing_state as string | null) ?? null,
          mailing_zip: (n.homeowner_mailing_zip as string | null) ?? null,
        },
        { onConflict: "contact_id" },
      );
  }

  // Upsert agent contact + sidecar when any agent fields are present.
  // Same hard rule for the agent's phone: no line type → not saved.
  let agentContactId: string | null = null;
  let agentPhoneDropped = 0;
  if (hasAgentFields(n)) {
    const agentPhone = (n.agent_phone as string | null) ?? null;
    const agentPhoneType = asLineType(n.agent_phone_type as string | null);
    const keepAgentPhone = !!agentPhone && agentPhoneType !== "unknown";
    if (agentPhone && !keepAgentPhone) agentPhoneDropped = 1;
    agentContactId = await upsertContact(supabase, {
      contact_type: "person",
      first_name: normalizeName(n.agent_first_name as string | null),
      last_name: normalizeName(n.agent_last_name as string | null),
      phone_1: keepAgentPhone ? agentPhone : null,
      phone_1_type: keepAgentPhone ? agentPhoneType : "unknown",
      email: (n.agent_email as string | null)?.trim().toLowerCase() ?? null,
    });
    await supabase.from("agent_details").upsert(
      {
        contact_id: agentContactId,
        brokerage: (n.agent_brokerage as string | null) ?? null,
        license_number: (n.agent_license_number as string | null) ?? null,
      },
      { onConflict: "contact_id" },
    );
  }

  // Layered dedup — try each ID in priority order.
  const zpid = (n.zpid as string | null) ?? null;
  const mlsNumber = (n.mls_number as string | null) ?? null;
  const apnNormalized = (n.apn as string | null) ?? null;

  const existingId = await findExistingProperty(supabase, {
    fipsCode,
    apnNormalized,
    zpid,
    mlsNumber,
    addressNormalized,
  });

  if (existingId) {
    // Contact enrichment on re-import: the homeowner/agent contact was
    // already upserted above. If this CSV row carries a contact the
    // existing property lacks, attach it — that's how a "skip-traced
    // contacts" re-export backfills owner data onto address-only rows
    // imported earlier. NULL-only fill: a property that already has a
    // linked contact is never rewired by an import.
    if (homeownerContactId || agentContactId) {
      const { data: existing } = await supabase
        .from("properties")
        .select("homeowner_contact_id, agent_contact_id")
        .eq("id", existingId)
        .single();
      const patch: Partial<PropertyInsert> = {};
      if (homeownerContactId && !existing?.homeowner_contact_id) {
        patch.homeowner_contact_id = homeownerContactId;
      }
      if (agentContactId && !existing?.agent_contact_id) {
        patch.agent_contact_id = agentContactId;
      }
      if (Object.keys(patch).length > 0) {
        const { error: patchError } = await supabase
          .from("properties")
          .update(patch)
          .eq("id", existingId);
        if (patchError) {
          throw new Error(
            `contact attach on dedup: ${patchError.message}`,
          );
        }
      }
    }
    return {
      propertyId: existingId,
      wasDuplicate: true,
      droppedUnlabeledPhones: phoneSlots.dropped + agentPhoneDropped,
    };
  }

  // The wizard's source selection (`defaultSource`) IS the canonical
  // value for properties.source — no translation table. A row-level
  // `source` mapped from the CSV (rare) overrides only when present.
  const mappedSource = (n.source as string | null) ?? null;

  const property: PropertyInsert = {
    // New imports land as 'prospect' by default. The /leads kanban filters
    // these out, keeping them on the /properties data-lake surface until
    // someone qualifies (manual action or auto on first inbound reply).
    status: "prospect",
    address: normalizeDisplayAddress(addressRaw) ?? addressRaw,
    city: normalizeDisplayAddress(n.city as string | null),
    state,
    zip: (n.zip as string | null) ?? null,
    market: market as PropertyInsert["market"],
    // Phase 02 D-04: market and county_id are set together at write
    // time. The wizard chose this id, the action validated it against
    // the counties table, and the workflow threaded it down here.
    county_id: countyId,
    fips_code: fipsCode,
    apn: (n.apn as string | null) ?? null,
    apn_normalized: apnNormalized,
    zpid,
    mls_number: mlsNumber,
    address_normalized: addressNormalized,
    beds: (n.beds as number | null) ?? null,
    baths: (n.baths as number | null) ?? null,
    sqft: (n.sqft as number | null) ?? null,
    year_built: (n.year_built as number | null) ?? null,
    listing_price: (n.listing_price as number | null) ?? null,
    arv: (n.arv as number | null) ?? null,
    repair_estimate: (n.repair_estimate as number | null) ?? null,
    mortgage_balance: (n.mortgage_balance as number | null) ?? null,
    equity_estimate: (n.equity_estimate as number | null) ?? null,
    lat: (n.lat as number | null) ?? null,
    lon: (n.lon as number | null) ?? null,
    source: (mappedSource ?? defaultSource) as PropertyInsert["source"],
    homeowner_contact_id: homeownerContactId,
    agent_contact_id: agentContactId,
  };

  const { data: inserted, error } = await supabase
    .from("properties")
    .insert(property)
    .select("id")
    .single();
  if (error) throw new Error(`property insert: ${error.message}`);
  return {
    propertyId: inserted.id,
    wasDuplicate: false,
    droppedUnlabeledPhones: phoneSlots.dropped + agentPhoneDropped,
  };
}

// ---------- helpers ----------

/**
 * Apply the hard rule to a row's homeowner phone slots: a phone whose
 * type normalizes to 'unknown' is dropped (never written), and the
 * surviving typed phones compact forward so phone_1 is always the first
 * usable number. Returns the contact-insert fields plus the dropped
 * count for the import summary.
 */
function compactTypedPhones(n: Readonly<Record<string, unknown>>): {
  contactFields: Pick<
    ContactInsert,
    | "phone_1"
    | "phone_1_type"
    | "phone_2"
    | "phone_2_type"
    | "phone_3"
    | "phone_3_type"
  >;
  dropped: number;
  /** Raw phone numbers dropped under the hard rule (no line type, or a
   *  DNC label) — never written to a contact's phone slots, but still
   *  needed by the caller to MATCH an existing contact (Codex PR #310
   *  finding 1: a DNC-labeled phone that's the only identifier on the
   *  row must still be able to find the contact it protects). */
  droppedPhones: string[];
} {
  const typed: { phone: string; type: PhoneLineType }[] = [];
  const droppedPhones: string[] = [];
  let dropped = 0;
  for (const slot of [1, 2, 3] as const) {
    const phone = (n[`homeowner_phone_${slot}`] as string | null) ?? null;
    if (!phone) continue;
    const type = asLineType(n[`homeowner_phone_${slot}_type`] as string | null);
    if (type === "unknown") {
      dropped++;
      droppedPhones.push(phone);
      continue;
    }
    typed.push({ phone, type });
  }
  return {
    contactFields: {
      phone_1: typed[0]?.phone ?? null,
      phone_1_type: typed[0]?.type ?? "unknown",
      phone_2: typed[1]?.phone ?? null,
      phone_2_type: typed[1]?.type ?? "unknown",
      phone_3: typed[2]?.phone ?? null,
      phone_3_type: typed[2]?.type ?? "unknown",
    },
    dropped,
    droppedPhones,
  };
}

function hasHomeownerFields(n: Readonly<Record<string, unknown>>): boolean {
  const keys = [
    "homeowner_first_name",
    "homeowner_last_name",
    "homeowner_entity_name",
    "homeowner_phone_1",
    "homeowner_phone_2",
    "homeowner_phone_3",
    "homeowner_email",
    "homeowner_mailing_address",
    // A row-level DNC signal must reach upsertContact even when it's the
    // ONLY homeowner field present — REISift's "DNC Excluded" sentinel
    // nulls the phone before this row ever reaches ingest, leaving nothing
    // else on the row (Codex PR #310 finding 3). Without this, a DNC-only
    // row skips the upsert entirely and an existing contact stays callable.
    "homeowner_do_not_contact",
  ];
  return keys.some((k) => n[k] != null);
}

function hasAgentFields(n: Readonly<Record<string, unknown>>): boolean {
  const keys = [
    "agent_first_name",
    "agent_last_name",
    "agent_phone",
    "agent_email",
    "agent_brokerage",
    "agent_license_number",
  ];
  return keys.some((k) => n[k] != null);
}

function deriveHomeownerContactType(
  n: Readonly<Record<string, unknown>>,
): "person" | "entity" {
  const explicit = n.homeowner_contact_type as string | null;
  if (explicit === "person" || explicit === "entity") return explicit;
  if (n.homeowner_entity_name) return "entity";
  return "person";
}

type ContactFields = Pick<
  ContactInsert,
  | "contact_type"
  | "first_name"
  | "last_name"
  | "entity_name"
  | "phone_1"
  | "phone_1_type"
  | "phone_2"
  | "phone_2_type"
  | "phone_3"
  | "phone_3_type"
  | "email"
  | "do_not_contact"
>;

async function upsertContact(
  supabase: SupabaseClient<Database>,
  contact: ContactFields,
  /** Every phone number this row carries, including ones dropped from
   *  `contact.phone_1/2/3` under the no-line-type hard rule (a DNC label
   *  normalizes to 'unknown' and gets dropped). Matching must still check
   *  these — a DNC-only row's whole purpose is finding and suppressing the
   *  contact that owns the flagged number. Defaults to just `phone_1` for
   *  callers (agent contacts) that don't pass it explicitly. */
  matchPhones: string[] = contact.phone_1 ? [contact.phone_1] : [],
): Promise<string> {
  // A matched (existing) contact only reaches an early return — the
  // trailing INSERT never runs — so compliance flags carried by the
  // incoming row would be silently dropped on a re-import. Ratchet the
  // Do Not Contact flag onto the matched row before returning. One-way
  // (false→true only): a row without the flag must never un-suppress a
  // contact that a prior import or an inbound STOP already protected.
  // The write is verified — a failed ratchet update must fail the row
  // (bubbles up through ingestRow to processIngestChunk's catch, which
  // marks it `error_class: "database"`) rather than silently reporting the
  // import as successful while the contact stays callable (Codex PR #310
  // finding 2).
  const onMatch = async (id: string): Promise<string> => {
    if (contact.do_not_contact === true) {
      const { error } = await supabase
        .from("contacts")
        .update({ do_not_contact: true })
        .eq("id", id);
      if (error) {
        throw new Error(
          `do_not_contact ratchet update failed for contact ${id}: ${error.message}`,
        );
      }
    }
    return id;
  };

  // Phone match — check every phone this row carries, not just the
  // surviving phone_1 (Codex PR #310 finding 1), against every slot an
  // EXISTING contact might hold that number in (phone_1/2/3), not just
  // their phone_1 (Codex PR #310 round-2 finding: a DNC number already
  // sitting in an existing contact's phone_2/phone_3 was invisible to a
  // phone_1-only lookup). A DNC-labeled phone that was the row's only
  // identifier must still be able to match an existing contact so the
  // ratchet above can suppress it.
  for (const phone of matchPhones) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .or(`phone_1.eq.${phone},phone_2.eq.${phone},phone_3.eq.${phone}`)
      .limit(1)
      .maybeSingle();
    if (data) return onMatch(data.id);
  }
  // Email match
  if (contact.email) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .ilike("email", contact.email)
      .limit(1)
      .maybeSingle();
    if (data) return onMatch(data.id);
  }
  // Name match — only for person-type contacts with no phone and no email.
  // The contacts table has a partial unique index on
  // (lower(last_name), lower(first_name)) where phone_1 IS NULL and
  // email IS NULL — designed to prevent duplicate "name-only ghost"
  // contacts. Without this branch, a re-import of a row whose owner had
  // no phone AND no email (D4D's `PH: Phone (Y/N/U) = N` case) would
  // hit the unique constraint on the trailing INSERT and fail the row.
  if (
    !contact.phone_1 &&
    !contact.email &&
    contact.contact_type === "person" &&
    contact.first_name &&
    contact.last_name
  ) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .ilike("first_name", contact.first_name)
      .ilike("last_name", contact.last_name)
      .eq("contact_type", "person")
      .is("phone_1", null)
      .is("email", null)
      .limit(1)
      .maybeSingle();
    if (data) return onMatch(data.id);
  }
  // Insert new
  const { data, error } = await supabase
    .from("contacts")
    .insert(contact)
    .select("id")
    .single();
  if (error) throw new Error(`contact insert: ${error.message}`);
  return data.id;
}

/**
 * Resolve (or create) the two auto-applied tags for this import:
 * `source:<vendor>` and `uploaded:YYYY-MM`. Returns their ids so the
 * per-row loop can upsert property_tags without another lookup. Both
 * rows are stamped `system_managed=true` — VAs can see them but can't
 * rename/delete from the custom-tags UI.
 */
async function resolveAutoTagIds(
  supabase: SupabaseClient<Database>,
  vendor: string,
): Promise<string[]> {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const want: {
    name: string;
    category: "source" | "marketing";
  }[] = [
    { name: `source:${vendor.toLowerCase()}`, category: "source" },
    { name: `uploaded:${month}`, category: "marketing" },
  ];

  const ids: string[] = [];
  for (const w of want) {
    // Look for an existing row first (case-sensitive since names are
    // lowercase/ASCII-only by construction).
    const { data: existing } = await supabase
      .from("tags")
      .select("id")
      .eq("name", w.name)
      .maybeSingle();
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const { data: inserted, error } = await supabase
      .from("tags")
      .insert({
        name: w.name,
        category: w.category,
        system_managed: true,
      })
      .select("id")
      .single();
    if (error) {
      // Non-fatal: don't block a 10K-row import because one tag row failed.
      // The per-row loop just skips this tag for this import.
      continue;
    }
    ids.push(inserted.id);
  }
  return ids;
}

/**
 * Upsert a (property, list) membership. On conflict (same pair already
 * exists — the stacking case: re-import of an address into the same list),
 * bump `last_added_at` + `last_added_by` + `last_source_import_id` so the
 * lead-detail "Lists" section shows fresh provenance, but don't reset
 * `first_added_at` — the earliest encounter stays recorded.
 *
 * Needs the property's org_id to satisfy the NOT NULL constraint on
 * property_lists.org_id; reads it from the property row (cheaper than
 * threading org_id through every per-row call).
 */
async function upsertPropertyListMembership(
  supabase: SupabaseClient<Database>,
  input: {
    propertyId: string;
    listId: string;
    userId: string | null;
    csvImportId: string;
  },
): Promise<void> {
  const { data: prop } = await supabase
    .from("properties")
    .select("org_id")
    .eq("id", input.propertyId)
    .maybeSingle();
  if (!prop) return; // property vanished between insert and upsert — rare

  const now = new Date().toISOString();
  await supabase
    .from("property_lists")
    .upsert(
      {
        org_id: prop.org_id,
        property_id: input.propertyId,
        list_id: input.listId,
        last_added_at: now,
        last_added_by: input.userId,
        last_source_import_id: input.csvImportId,
      },
      {
        onConflict: "property_id,list_id",
        // On a conflict (already a member), we ONLY want to bump the
        // "last" columns. Supabase's upsert replaces the whole row — we
        // need the INSERT-default `first_added_at` to NOT be overwritten.
        // The DB has `first_added_at DEFAULT now()` which fires only on
        // INSERT, not on the conflict-UPDATE path, so the original value
        // survives. Verified by integration tests.
        ignoreDuplicates: false,
      },
    );
}

async function findExistingProperty(
  supabase: SupabaseClient<Database>,
  keys: {
    fipsCode: string | null;
    apnNormalized: string | null;
    zpid: string | null;
    mlsNumber: string | null;
    addressNormalized: string | null;
  },
): Promise<string | null> {
  // All four tiers of the dedup cascade filter out soft-deleted rows.
  // Without this, re-importing after `properties.deleted_at = now()` would
  // dedup-match the ghosts and silently skip every row — making "clear
  // prospects and start over" impossible. The semantic we want: soft-delete
  // means "treat as gone for ingestion purposes too." If a user wants to
  // resurrect rather than create fresh on re-import, that's a separate
  // explicit flow (not implemented today).
  if (keys.fipsCode && keys.apnNormalized) {
    const { data } = await supabase
      .from("properties")
      .select("id")
      .eq("fips_code", keys.fipsCode)
      .eq("apn_normalized", keys.apnNormalized)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  if (keys.zpid) {
    const { data } = await supabase
      .from("properties")
      .select("id")
      .eq("zpid", keys.zpid)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  if (keys.mlsNumber) {
    const { data } = await supabase
      .from("properties")
      .select("id")
      .eq("mls_number", keys.mlsNumber)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  if (keys.addressNormalized) {
    const { data } = await supabase
      .from("properties")
      .select("id")
      .eq("address_normalized", keys.addressNormalized)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  return null;
}
