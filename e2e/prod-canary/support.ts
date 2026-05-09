import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/supabase/types";

const DEFAULT_PROD_BASE_URL = "https://sandra-sooty.vercel.app";
const PROD_PROJECT_REF = "copflsklaefwzipsrjqz";
const TEST_PROJECT_REF = "ncsngxlcyxylaeskiteu";

export const PROD_CANARY_AUTH_FILE = "e2e/.auth/prod-canary.json";

export type ProdCanaryEnv = {
  baseURL: string;
  email: string;
  password: string;
  runId: string;
  label: string;
};

type PropertyInsert = Database["public"]["Tables"]["properties"]["Insert"];

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

export function requireProdCanaryEnv(): ProdCanaryEnv {
  const baseURL = process.env.PROD_BASE_URL ?? DEFAULT_PROD_BASE_URL;
  const email = process.env.PROD_EMAIL;
  const password = process.env.PROD_PASSWORD;

  if (process.env.RUN_PROD_CANARIES !== "1") {
    throw new Error(
      "Production canaries are disabled. Set RUN_PROD_CANARIES=1 to run them.",
    );
  }
  if (!baseURL.startsWith("https://") || baseURL.includes("localhost")) {
    throw new Error(`PROD_BASE_URL must be a deployed https URL. Got ${baseURL}`);
  }
  if (!email || !password) {
    throw new Error(
      "Set PROD_EMAIL and PROD_PASSWORD for the dedicated Sandra canary user.",
    );
  }

  const runId =
    process.env.PROD_CANARY_RUN_ID ??
    `prod-canary-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  return {
    baseURL,
    email,
    password,
    runId,
    label: `PROD-CANARY ${runId}`,
  };
}

export function requireProdCanarySupabase(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for production canary persistence checks.",
    );
  }
  if (url.includes(TEST_PROJECT_REF)) {
    throw new Error("Refusing to run production canaries against the test project.");
  }
  if (!url.includes(PROD_PROJECT_REF)) {
    throw new Error(`Supabase URL ${url} does not match the Sandra production ref.`);
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function assertCanaryOwned(value: string, context: string): void {
  if (!value.includes("PROD-CANARY")) {
    throw new Error(`${context} must include PROD-CANARY before cleanup/write.`);
  }
}

export function requireCanarySmsRecipient(): string {
  const phone = process.env.PROD_CANARY_SMS_TO;
  const allowlist = (process.env.PROD_CANARY_SMS_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!phone) {
    throw new Error(
      "Set PROD_CANARY_SMS_TO to an owned, allowlisted E.164 recipient before running SMS production canaries.",
    );
  }
  if (!/^\+\d{10,15}$/.test(phone)) {
    throw new Error(`PROD_CANARY_SMS_TO must be E.164. Got ${phone}`);
  }
  if (!allowlist.includes(phone)) {
    throw new Error(
      "PROD_CANARY_SMS_TO must also appear in PROD_CANARY_SMS_ALLOWLIST before a provider-backed canary can send.",
    );
  }

  return phone;
}

export async function deleteCanaryListsByName(
  client: SupabaseClient<Database>,
  name: string,
): Promise<void> {
  assertCanaryOwned(name, "list name");

  const { data: lists, error: lookupError } = await client
    .from("lists")
    .select("id, name")
    .eq("name", name);
  if (lookupError) {
    throw new Error(`Could not look up canary lists: ${lookupError.message}`);
  }

  const ids = (lists ?? []).map((list) => list.id);
  if (ids.length === 0) return;

  const { error: membershipError } = await client
    .from("property_lists")
    .delete()
    .in("list_id", ids);
  if (membershipError) {
    throw new Error(
      `Could not delete canary list memberships: ${membershipError.message}`,
    );
  }

  const { error: deleteError } = await client.from("lists").delete().in("id", ids);
  if (deleteError) {
    throw new Error(`Could not delete canary lists: ${deleteError.message}`);
  }
}

export async function deleteCanaryImportArtifactsByFilename(
  client: SupabaseClient<Database>,
  filename: string,
): Promise<void> {
  assertCanaryOwned(filename, "import filename");

  const { data: imports, error: importLookupError } = await client
    .from("csv_imports")
    .select("id, storage_path, filename")
    .eq("filename", filename);
  if (importLookupError) {
    throw new Error(
      `Could not look up canary import artifacts: ${importLookupError.message}`,
    );
  }

  const importIds = (imports ?? []).map((row) => row.id);
  const storagePaths = (imports ?? [])
    .map((row) => row.storage_path)
    .filter((path): path is string => !!path);
  if (storagePaths.length > 0) {
    const { error } = await client.storage.from("csv-imports").remove(storagePaths);
    if (error) {
      throw new Error(`Could not delete canary import storage: ${error.message}`);
    }
  }
  if (importIds.length === 0) return;

  const { data: jobs, error: jobLookupError } = await client
    .from("jobs")
    .select("id")
    .in("related_import_id", importIds);
  if (jobLookupError) {
    throw new Error(`Could not look up canary import jobs: ${jobLookupError.message}`);
  }

  const jobIds = (jobs ?? []).map((row) => row.id);
  if (jobIds.length > 0) {
    const { error: itemError } = await client
      .from("job_items")
      .delete()
      .in("job_id", jobIds);
    if (itemError) {
      throw new Error(`Could not delete canary job items: ${itemError.message}`);
    }

    const { error: jobError } = await client.from("jobs").delete().in("id", jobIds);
    if (jobError) {
      throw new Error(`Could not delete canary jobs: ${jobError.message}`);
    }
  }

  const { error: importError } = await client
    .from("csv_imports")
    .delete()
    .in("id", importIds);
  if (importError) {
    throw new Error(`Could not delete canary imports: ${importError.message}`);
  }
}

export async function deleteCanaryContactsByLastName(
  client: SupabaseClient<Database>,
  lastName: string,
): Promise<void> {
  assertCanaryOwned(lastName, "contact last name");

  const { data: contacts, error: lookupError } = await client
    .from("contacts")
    .select("id, last_name")
    .eq("last_name", lastName);
  if (lookupError) {
    throw new Error(`Could not look up canary contacts: ${lookupError.message}`);
  }

  const ids = (contacts ?? []).map((contact) => contact.id);
  if (ids.length === 0) return;

  const { error: messageError } = await client
    .from("messages")
    .delete()
    .in("contact_id", ids);
  if (messageError) {
    throw new Error(
      `Could not delete canary contact messages: ${messageError.message}`,
    );
  }

  const { error: consentError } = await client
    .from("consent_events")
    .delete()
    .in("contact_id", ids);
  if (consentError) {
    throw new Error(
      `Could not delete canary contact consent events: ${consentError.message}`,
    );
  }

  const { error: contactError } = await client.from("contacts").delete().in("id", ids);
  if (contactError) {
    throw new Error(`Could not delete canary contacts: ${contactError.message}`);
  }
}

export async function deleteCanarySmsTemplatesByName(
  client: SupabaseClient<Database>,
  name: string,
): Promise<void> {
  assertCanaryOwned(name, "template name");

  const { data: templates, error: lookupError } = await client
    .from("sms_templates")
    .select("id, name")
    .eq("name", name);
  if (lookupError) {
    throw new Error(
      `Could not look up canary sms templates: ${lookupError.message}`,
    );
  }

  const ids = (templates ?? []).map((template) => template.id);
  if (ids.length === 0) return;

  const { error: stepError } = await client
    .from("sequence_steps")
    .update({ template_id: null })
    .in("template_id", ids);
  if (stepError) {
    throw new Error(
      `Could not detach canary sms templates from sequence steps: ${stepError.message}`,
    );
  }

  const { error: deleteError } = await client
    .from("sms_templates")
    .delete()
    .in("id", ids);
  if (deleteError) {
    throw new Error(
      `Could not delete canary sms templates: ${deleteError.message}`,
    );
  }
}

export async function insertCanaryList(
  client: SupabaseClient<Database>,
  input: { name: string },
): Promise<{ id: string; name: string }> {
  assertCanaryOwned(input.name, "list name");

  const { data, error } = await client
    .from("lists")
    .insert({
      name: input.name,
      description: "Created by production Playwright canary.",
      color: "#111827",
    })
    .select("id, name")
    .single();
  if (error || !data) {
    throw error ?? new Error("Could not insert canary list.");
  }
  return { id: data.id, name: data.name };
}

export async function insertCanaryProspect(
  client: SupabaseClient<Database>,
  input: {
    address: string;
    runId: string;
    fields?: Partial<
      Pick<
        PropertyInsert,
        | "arv"
        | "cass_status"
        | "equity_estimate"
        | "homeowner_contact_id"
        | "is_vacant"
        | "market"
        | "source"
        | "state"
        | "status"
      >
    >;
  },
): Promise<{ id: string; address: string }> {
  assertCanaryOwned(input.address, "property address");

  const { data, error } = await client
    .from("properties")
    .insert({
      address: input.address,
      city: "Kansas City",
      state: "MO",
      zip: "64151",
      market: "Kansas City",
      status: "prospect",
      cass_status: "verified",
      is_vacant: false,
      notes: `Created by production Playwright canary ${input.runId}`,
      ...input.fields,
    })
    .select("id, address")
    .single();
  if (error || !data) {
    throw error ?? new Error("Could not insert canary prospect.");
  }
  return { id: data.id, address: data.address };
}

export async function insertCanaryProspects(
  client: SupabaseClient<Database>,
  input: Array<{
    address: string;
    runId: string;
    fields?: Partial<
      Pick<
        PropertyInsert,
        | "arv"
        | "cass_status"
        | "equity_estimate"
        | "homeowner_contact_id"
        | "is_vacant"
        | "market"
        | "source"
        | "state"
        | "status"
      >
    >;
  }>,
): Promise<Array<{ id: string; address: string }>> {
  if (input.length === 0) return [];
  for (const row of input) {
    assertCanaryOwned(row.address, "property address");
  }

  const rows = input.map((row) => ({
    address: row.address,
    city: "Kansas City",
    state: "MO",
    zip: "64151",
    market: "Kansas City",
    status: "prospect",
    cass_status: "verified",
    is_vacant: false,
    notes: `Created by production Playwright canary ${row.runId}`,
    ...row.fields,
  }));

  const inserted: Array<{ id: string; address: string }> = [];
  for (const batch of chunks(rows, 100)) {
    const { data, error } = await client
      .from("properties")
      .insert(batch)
      .select("id, address");
    if (error || !data) {
      throw error ?? new Error("Could not insert canary prospects.");
    }
    inserted.push(...data.map((row) => ({ id: row.id, address: row.address })));
  }

  return inserted;
}

export async function insertCanaryListMemberships(
  client: SupabaseClient<Database>,
  input: { listId: string; propertyIds: string[] },
): Promise<void> {
  if (input.propertyIds.length === 0) return;

  const rows = input.propertyIds.map((propertyId) => ({
    list_id: input.listId,
    property_id: propertyId,
  }));

  for (const batch of chunks(rows, 100)) {
    const { error } = await client.from("property_lists").insert(batch);
    if (error) {
      throw new Error(
        `Could not insert canary list memberships: ${error.message}`,
      );
    }
  }
}

export async function deleteCanaryPropertiesByAddress(
  client: SupabaseClient<Database>,
  address: string,
): Promise<void> {
  assertCanaryOwned(address, "property address");

  const { data: properties, error: lookupError } = await client
    .from("properties")
    .select("id, address")
    .eq("address", address);
  if (lookupError) {
    throw new Error(
      `Could not look up canary properties: ${lookupError.message}`,
    );
  }

  const ids = (properties ?? []).map((property) => property.id);
  if (ids.length === 0) return;

  const { error: listError } = await client
    .from("property_lists")
    .delete()
    .in("property_id", ids);
  if (listError) {
    throw new Error(
      `Could not delete canary property list memberships: ${listError.message}`,
    );
  }

  const { error: messageError } = await client
    .from("messages")
    .delete()
    .in("property_id", ids);
  if (messageError) {
    throw new Error(
      `Could not delete canary property messages: ${messageError.message}`,
    );
  }

  const { error: propertyError } = await client
    .from("properties")
    .delete()
    .in("id", ids);
  if (propertyError) {
    throw new Error(
      `Could not delete canary properties: ${propertyError.message}`,
    );
  }
}

export async function deleteCanaryPropertiesByAddressPrefix(
  client: SupabaseClient<Database>,
  prefix: string,
): Promise<void> {
  assertCanaryOwned(prefix, "property address prefix");

  const { data: properties, error: lookupError } = await client
    .from("properties")
    .select("id, address")
    .like("address", `${prefix}%`);
  if (lookupError) {
    throw new Error(
      `Could not look up canary properties by prefix: ${lookupError.message}`,
    );
  }

  const ids = (properties ?? []).map((property) => property.id);
  if (ids.length === 0) return;

  for (const batch of chunks(ids, 50)) {
    const { error: listError } = await client
      .from("property_lists")
      .delete()
      .in("property_id", batch);
    if (listError) {
      throw new Error(
        `Could not delete canary property list memberships: ${listError.message}`,
      );
    }

    const { error: messageError } = await client
      .from("messages")
      .delete()
      .in("property_id", batch);
    if (messageError) {
      throw new Error(
        `Could not delete canary property messages: ${messageError.message}`,
      );
    }

    const { error: propertyError } = await client
      .from("properties")
      .delete()
      .in("id", batch);
    if (propertyError) {
      throw new Error(
        `Could not delete canary properties: ${propertyError.message}`,
      );
    }
  }
}

export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  opts: { intervalMs?: number; timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 1_000;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const label = opts.label ?? "condition";
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}
