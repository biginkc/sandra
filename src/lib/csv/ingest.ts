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

export async function runIngestion(
  supabase: SupabaseClient<Database>,
  params: IngestParams,
): Promise<IngestSummary> {
  await supabase
    .from("jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      total_items: params.rows.length,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", params.jobId);

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const errors: { rowIndex: number; message: string }[] = [];

  for (let i = 0; i < params.rows.length; i++) {
    const row = params.rows[i];
    const validated = validateRow(row, params.mapping, i);

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
        errors.push({ rowIndex: i, message: msg });
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
        errors.push({ rowIndex: i, message });
    }

    // Progress update every N rows (and on the final row)
    if (
      (i + 1) % PROGRESS_UPDATE_INTERVAL === 0 ||
      i === params.rows.length - 1
    ) {
      await supabase
        .from("jobs")
        .update({
          processed_items: i + 1,
          succeeded_items: succeeded,
          failed_items: failed,
          worker_heartbeat_at: new Date().toISOString(),
        })
        .eq("id", params.jobId);
    }
  }

  const status: Database["public"]["Tables"]["jobs"]["Update"]["status"] =
    failed === 0 && params.rows.length > 0
      ? "completed"
      : succeeded > 0
        ? "partial"
        : "failed";

  await supabase
    .from("jobs")
    .update({
      status,
      processed_items: params.rows.length,
      succeeded_items: succeeded,
      failed_items: failed,
      completed_at: new Date().toISOString(),
      result_summary: {
        succeeded,
        failed,
        skipped,
        errors: errors.slice(0, ERROR_SAMPLE_SIZE),
      },
    })
    .eq("id", params.jobId);

  await supabase
    .from("csv_imports")
    .update({
      inserted_properties: succeeded,
      skipped_duplicates: skipped,
      failed_rows: failed,
      total_rows: params.rows.length,
    })
    .eq("id", params.csvImportId);

  return { succeeded, failed, skipped, errors };
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
  if (keys.fipsCode && keys.apnNormalized) {
    const { data } = await supabase
      .from("properties")
      .select("id")
      .eq("fips_code", keys.fipsCode)
      .eq("apn_normalized", keys.apnNormalized)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  if (keys.zpid) {
    const { data } = await supabase
      .from("properties")
      .select("id")
      .eq("zpid", keys.zpid)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  if (keys.mlsNumber) {
    const { data } = await supabase
      .from("properties")
      .select("id")
      .eq("mls_number", keys.mlsNumber)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  if (keys.addressNormalized) {
    const { data } = await supabase
      .from("properties")
      .select("id")
      .eq("address_normalized", keys.addressNormalized)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  return null;
}
