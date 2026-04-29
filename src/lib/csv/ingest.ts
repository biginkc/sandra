import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types";
import { resolveFips } from "./fips";
import { normalizeAddress } from "./normalize";
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
  mapping: Mapping;
  /** The rows for THIS chunk only. Caller is responsible for slicing. */
  rows: RowData[];
  /** The 0-based offset of `rows[0]` within the full CSV — used for progress
   *  reporting and the `rowIndex` in error samples. */
  offset: number;
  autoTagIds: string[];
  listId?: string | null;
  userId?: string | null;
};

export type ChunkResult = {
  succeeded: number;
  failed: number;
  skipped: number;
  errors: { rowIndex: number; message: string }[];
};

const PROGRESS_UPDATE_INTERVAL = 10;
const ERROR_SAMPLE_SIZE = 20;

/**
 * Map the CSV vendor (`dealmachine`, `zillow`, etc. — chosen in Step 1 of the
 * wizard) to a sensible default `properties.source` value when the CSV itself
 * doesn't map a Source column. `properties.source` is a distinct enum about
 * how the lead entered the pipeline; the vendor selection is about who
 * exported the data.
 */
const VENDOR_DEFAULT_SOURCE: Record<string, PropertyInsert["source"]> = {
  dealmachine: "driving_for_dollars",
  zillow: "mls",
  realtor: "mls",
  mls: "mls",
  generic: "other",
};

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
    errors: chunk.errors,
  });

  return {
    succeeded: chunk.succeeded,
    failed: chunk.failed,
    skipped: chunk.skipped,
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
      );

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
    // wizard sees movement even if a chunk happens to be small.
    const isLastInChunk = localIndex === params.rows.length - 1;
    if ((absoluteIndex + 1) % PROGRESS_UPDATE_INTERVAL === 0 || isLastInChunk) {
      await supabase
        .from("jobs")
        .update({
          processed_items: absoluteIndex + 1,
          worker_heartbeat_at: new Date().toISOString(),
        })
        .eq("id", params.jobId);
    }
  }

  return { succeeded, failed, skipped, errors };
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
): Promise<{ propertyId: string; wasDuplicate: boolean }> {
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

  // Upsert homeowner contact + sidecar when any homeowner fields are present.
  let homeownerContactId: string | null = null;
  if (hasHomeownerFields(n)) {
    homeownerContactId = await upsertContact(supabase, {
      contact_type: deriveHomeownerContactType(n),
      first_name: (n.homeowner_first_name as string | null) ?? null,
      last_name: (n.homeowner_last_name as string | null) ?? null,
      entity_name: (n.homeowner_entity_name as string | null) ?? null,
      phone_1: (n.homeowner_phone_1 as string | null) ?? null,
      phone_2: (n.homeowner_phone_2 as string | null) ?? null,
      phone_3: (n.homeowner_phone_3 as string | null) ?? null,
      email: (n.homeowner_email as string | null) ?? null,
      do_not_contact:
        (n.homeowner_do_not_contact as boolean | null) ?? undefined,
    });
    await supabase
      .from("homeowner_details")
      .upsert(
        {
          contact_id: homeownerContactId,
          mailing_address:
            (n.homeowner_mailing_address as string | null) ?? null,
          mailing_city: (n.homeowner_mailing_city as string | null) ?? null,
          mailing_state: (n.homeowner_mailing_state as string | null) ?? null,
          mailing_zip: (n.homeowner_mailing_zip as string | null) ?? null,
        },
        { onConflict: "contact_id" },
      );
  }

  // Upsert agent contact + sidecar when any agent fields are present.
  let agentContactId: string | null = null;
  if (hasAgentFields(n)) {
    agentContactId = await upsertContact(supabase, {
      contact_type: "person",
      first_name: (n.agent_first_name as string | null) ?? null,
      last_name: (n.agent_last_name as string | null) ?? null,
      phone_1: (n.agent_phone as string | null) ?? null,
      email: (n.agent_email as string | null) ?? null,
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
    return { propertyId: existingId, wasDuplicate: true };
  }

  const mappedSource = (n.source as string | null) ?? null;
  const vendorFallback =
    VENDOR_DEFAULT_SOURCE[defaultSource.toLowerCase()] ?? null;

  const property: PropertyInsert = {
    // New imports land as 'prospect' by default. The /leads kanban filters
    // these out, keeping them on the /properties data-lake surface until
    // someone qualifies (manual action or auto on first inbound reply).
    status: "prospect",
    address: addressRaw,
    city: (n.city as string | null) ?? null,
    state,
    zip: (n.zip as string | null) ?? null,
    market: market as PropertyInsert["market"],
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
    source: (mappedSource ?? vendorFallback) as PropertyInsert["source"],
    homeowner_contact_id: homeownerContactId,
    agent_contact_id: agentContactId,
  };

  const { data: inserted, error } = await supabase
    .from("properties")
    .insert(property)
    .select("id")
    .single();
  if (error) throw new Error(`property insert: ${error.message}`);
  return { propertyId: inserted.id, wasDuplicate: false };
}

// ---------- helpers ----------

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
  | "phone_2"
  | "phone_3"
  | "email"
  | "do_not_contact"
>;

async function upsertContact(
  supabase: SupabaseClient<Database>,
  contact: ContactFields,
): Promise<string> {
  // Phone-first match
  if (contact.phone_1) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .eq("phone_1", contact.phone_1)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  // Email match
  if (contact.email) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .ilike("email", contact.email)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
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
    if (data) return data.id;
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
