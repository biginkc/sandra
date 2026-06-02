import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, createHmac } from "node:crypto";

import {
  DEFAULT_PROD_BASE_URL,
  assertProdSupabaseUrl,
  loadProdCanaryEnvFiles,
} from "../../src/lib/prod-canary/env";
import type { Database } from "../../src/lib/supabase/types";

loadProdCanaryEnvFiles();

export const PROD_CANARY_AUTH_FILE = "e2e/.auth/prod-canary.json";

export type ProdCanaryEnv = {
  baseURL: string;
  email: string;
  password: string;
  runId: string;
  label: string;
};

type PropertyInsert = Database["public"]["Tables"]["properties"]["Insert"];
type PostgrestError = { message: string };
type UntypedQueryResult = {
  data: Array<Record<string, unknown>> | null;
  error: PostgrestError | null;
};
type UntypedQuerySingleResult = {
  data: Record<string, unknown> | null;
  error: PostgrestError | null;
};
type UntypedQuery = PromiseLike<UntypedQueryResult> & {
  delete(): UntypedQuery;
  eq(column: string, value: unknown): UntypedQuery;
  in(column: string, values: unknown[]): UntypedQuery;
  insert(values: unknown): UntypedQuery;
  select(columns?: string): UntypedQuery;
  single(): Promise<UntypedQuerySingleResult>;
  update(values: unknown): UntypedQuery;
};
type UntypedSupabase = {
  from(table: string): UntypedQuery;
};

function fromUntyped(
  client: SupabaseClient<Database>,
  table: string,
): UntypedQuery {
  return (client as unknown as UntypedSupabase).from(table);
}

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
  assertProdSupabaseUrl(url);
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function assertCanaryOwned(value: string, context: string): void {
  if (!value.includes("PROD-CANARY")) {
    throw new Error(`${context} must include PROD-CANARY before cleanup/write.`);
  }
}

export function hashCanarySecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function signCanaryJson(body: string, token: string): string {
  return "sha256=" + createHmac("sha256", token).update(body).digest("hex");
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

export function requireDialpadWebhookTarget(): string {
  const fromNumber = process.env.DIALPAD_FROM_NUMBER ?? "+18162804181";
  if (!/^\+\d{10,15}$/.test(fromNumber)) {
    throw new Error(`DIALPAD_FROM_NUMBER must be E.164. Got ${fromNumber}`);
  }
  return fromNumber;
}

function base64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export async function fireSignedDialpadInbound(
  input: {
    baseURL: string;
    id: string;
    fromNumber: string;
    toNumber: string;
    text: string;
  },
): Promise<number> {
  const secret = process.env.DIALPAD_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "Set DIALPAD_WEBHOOK_SECRET before running signed inbound webhook production canaries.",
    );
  }

  const event = {
    id: input.id,
    from_number: input.fromNumber,
    to_number: input.toNumber,
    text: input.text,
    timestamp: new Date().toISOString(),
  };
  const header = base64url(
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8"),
  );
  const payload = base64url(Buffer.from(JSON.stringify(event), "utf8"));
  const signature = base64url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );

  const response = await fetch(`${input.baseURL}/api/webhooks/dialpad/sms`, {
    method: "POST",
    headers: { "content-type": "application/jwt" },
    body: `${header}.${payload}.${signature}`,
  });

  return response.status;
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

export async function deleteCanaryOrganizationsByName(
  client: SupabaseClient<Database>,
  name: string,
): Promise<void> {
  assertCanaryOwned(name, "organization name");

  const { data: organizations, error: lookupError } = await client
    .from("organizations")
    .select("id, name")
    .eq("name", name);
  if (lookupError) {
    throw new Error(
      `Could not look up canary organizations: ${lookupError.message}`,
    );
  }

  const ids = (organizations ?? []).map((organization) => organization.id);
  if (ids.length === 0) return;

  const { error: deleteError } = await client
    .from("organizations")
    .delete()
    .in("id", ids);
  if (deleteError) {
    throw new Error(`Could not delete canary organizations: ${deleteError.message}`);
  }
}

export async function deleteCanaryWebhookConsumersByName(
  client: SupabaseClient<Database>,
  name: string,
): Promise<void> {
  assertCanaryOwned(name, "webhook consumer name");

  const { error } = await client.from("webhook_consumers").delete().eq("name", name);
  if (error) {
    throw new Error(`Could not delete canary webhook consumers: ${error.message}`);
  }
}

export async function deleteCanaryWebhookEventsByExternalIds(
  client: SupabaseClient<Database>,
  externalIds: string[],
): Promise<void> {
  if (externalIds.length === 0) return;
  for (const externalId of externalIds) {
    assertCanaryOwned(externalId, "webhook event external id");
  }

  const { error } = await client
    .from("webhook_events")
    .delete()
    .in("external_id", externalIds);
  if (error) {
    throw new Error(`Could not delete canary webhook events: ${error.message}`);
  }
}

export async function insertCanaryJitterWebhookConsumer(
  client: SupabaseClient<Database>,
  input: { name: string; orgId: string; token: string },
): Promise<{ id: string; name: string }> {
  assertCanaryOwned(input.name, "webhook consumer name");

  const { data, error } = await client
    .from("webhook_consumers")
    .insert({
      consumer_type: "jitter_writeback",
      enabled: true,
      name: input.name,
      notes: "Created by production Playwright canary.",
      org_id: input.orgId,
      secret_hash: hashCanarySecret(input.token),
    })
    .select("id, name")
    .single();
  if (error || !data) {
    throw error ?? new Error("Could not insert canary webhook consumer.");
  }
  return { id: data.id, name: data.name };
}

export async function insertCanaryOrganization(
  client: SupabaseClient<Database>,
  input: { name: string },
): Promise<{ id: string; name: string }> {
  assertCanaryOwned(input.name, "organization name");

  const { data, error } = await client
    .from("organizations")
    .insert({ name: input.name })
    .select("id, name")
    .single();
  if (error || !data) {
    throw error ?? new Error("Could not insert canary organization.");
  }
  return { id: data.id, name: data.name };
}

export async function deleteCanaryDialerArtifactsByBatchTitle(
  client: SupabaseClient<Database>,
  title: string,
): Promise<void> {
  assertCanaryOwned(title, "dialer batch title");

  const { data: batches, error: batchLookupError } = await fromUntyped(
    client,
    "dialer_batches",
  )
    .select("id")
    .eq("title", title);
  if (batchLookupError) {
    throw new Error(
      `Could not look up canary dialer batches: ${batchLookupError.message}`,
    );
  }

  const batchIds = (batches ?? []).map((row) => String(row.id));
  if (batchIds.length === 0) return;

  const { data: items, error: itemLookupError } = await fromUntyped(
    client,
    "dialer_batch_items",
  )
    .select("id")
    .in("batch_id", batchIds);
  if (itemLookupError) {
    throw new Error(
      `Could not look up canary dialer batch items: ${itemLookupError.message}`,
    );
  }

  const itemIds = (items ?? []).map((row) => String(row.id));
  if (itemIds.length > 0) {
    const { data: activities, error: activityLookupError } = await fromUntyped(
      client,
      "call_activities",
    )
      .select("id")
      .in("dialer_batch_item_id", itemIds);
    if (activityLookupError) {
      throw new Error(
        `Could not look up canary call activities: ${activityLookupError.message}`,
      );
    }

    const activityIds = (activities ?? []).map((row) => String(row.id));
    if (activityIds.length > 0) {
      const { error: recordingError } = await fromUntyped(
        client,
        "call_recordings",
      )
        .delete()
        .in("call_activity_id", activityIds);
      if (recordingError) {
        throw new Error(
          `Could not delete canary call recordings: ${recordingError.message}`,
        );
      }

      const { error: transcriptError } = await fromUntyped(
        client,
        "call_transcripts",
      )
        .delete()
        .in("call_activity_id", activityIds);
      if (transcriptError) {
        throw new Error(
          `Could not delete canary call transcripts: ${transcriptError.message}`,
        );
      }

      const { error: activityError } = await fromUntyped(
        client,
        "call_activities",
      )
        .delete()
        .in("id", activityIds);
      if (activityError) {
        throw new Error(
          `Could not delete canary call activities: ${activityError.message}`,
        );
      }
    }
  }

  const { error: batchError } = await fromUntyped(client, "dialer_batches")
    .delete()
    .in("id", batchIds);
  if (batchError) {
    throw new Error(`Could not delete canary dialer batches: ${batchError.message}`);
  }
}

export async function fetchSingleUntypedRow(
  client: SupabaseClient<Database>,
  table: string,
  columns: string,
  eq: { column: string; value: unknown },
): Promise<Record<string, unknown>> {
  const { data, error } = await fromUntyped(client, table)
    .select(columns)
    .eq(eq.column, eq.value)
    .single();
  if (error || !data) {
    throw error ?? new Error(`Could not fetch ${table} row.`);
  }
  return data;
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

export async function deleteCanaryUpdateJobsByFilename(
  client: SupabaseClient<Database>,
  filename: string,
): Promise<void> {
  assertCanaryOwned(filename, "update filename");

  const { data: jobs, error: lookupError } = await client
    .from("jobs")
    .select("id, title")
    .eq("type", "csv_update")
    .eq("title", `Update ${filename}`);
  if (lookupError) {
    throw new Error(`Could not look up canary update jobs: ${lookupError.message}`);
  }

  const jobIds = (jobs ?? []).map((row) => row.id);
  if (jobIds.length === 0) return;

  const { error: itemError } = await client
    .from("job_items")
    .delete()
    .in("job_id", jobIds);
  if (itemError) {
    throw new Error(`Could not delete canary update job items: ${itemError.message}`);
  }

  const { error: jobError } = await client.from("jobs").delete().in("id", jobIds);
  if (jobError) {
    throw new Error(`Could not delete canary update jobs: ${jobError.message}`);
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

export async function deleteCanaryConsentBySource(
  client: SupabaseClient<Database>,
  input: { contactId: string; source: string },
): Promise<void> {
  assertCanaryOwned(input.source, "consent source");

  const { error } = await client
    .from("consent_events")
    .delete()
    .eq("contact_id", input.contactId)
    .eq("source", input.source);
  if (error) {
    throw new Error(`Could not delete canary consent events: ${error.message}`);
  }
}

export async function getOrCreateCanarySmsRecipientContact(
  client: SupabaseClient<Database>,
  input: { firstName: string; lastName: string; phone: string },
): Promise<{ id: string; created: boolean }> {
  assertCanaryOwned(input.lastName, "contact last name");

  const { data: existing, error: lookupError } = await client
    .from("contacts")
    .select("id")
    .eq("phone_1", input.phone)
    .maybeSingle();
  if (lookupError) {
    throw new Error(`Could not look up canary SMS contact: ${lookupError.message}`);
  }
  if (existing?.id) {
    return { id: existing.id, created: false };
  }

  const { data: contact, error: contactError } = await client
    .from("contacts")
    .insert({
      first_name: input.firstName,
      last_name: input.lastName,
      phone_1: input.phone,
    })
    .select("id")
    .single();
  if (contactError || !contact?.id) {
    throw contactError ?? new Error("Could not insert canary SMS contact.");
  }

  return { id: contact.id, created: true };
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
        | "ai_responder_disabled"
        | "address_normalized"
        | "cass_status"
        | "equity_estimate"
        | "homeowner_contact_id"
        | "is_vacant"
        | "market"
        | "notes"
        | "org_id"
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
        | "ai_responder_disabled"
        | "address_normalized"
        | "cass_status"
        | "equity_estimate"
        | "homeowner_contact_id"
        | "is_vacant"
        | "market"
        | "notes"
        | "org_id"
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
