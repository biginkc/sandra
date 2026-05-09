import { createHash, createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { BMH_ORG_ID, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

export const JITTER_TOKEN = "jitter-route-integration-token";

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sign(body: string): string {
  return "sha256=" + createHmac("sha256", JITTER_TOKEN).update(body).digest("hex");
}

export function authHeaders(body: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${JITTER_TOKEN}`,
    "x-sandra-signature": sign(body),
    ...extra,
  };
}

export function jsonRequest(
  url: string,
  method: "POST" | "PATCH" | "PUT",
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  const rawBody = JSON.stringify(body);
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...authHeaders(rawBody, extraHeaders),
    },
    body: rawBody,
  });
}

export function signedGet(url: string, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "GET",
    headers: authHeaders("", headers),
  });
}

export function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

export async function resetJitterIntegration(client: SupabaseClient<any>) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.TEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
  await seedTwoOrgs(client);
  await resetTenantTables(client);
  await seedTwoOrgs(client);
  await client
    .from("webhook_consumers")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  await client.from("webhook_consumers").insert({
    consumer_type: "jitter_writeback",
    name: "jitter-route-tests",
    secret_hash: hashSecret(JITTER_TOKEN),
    enabled: true,
  });
}

let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `+1816888${String(phoneSeq).padStart(4, "0")}`;
}

export async function seedDialerLead(
  client: SupabaseClient<any>,
  opts: {
    state?: string;
    phone_1?: string | null;
    do_not_contact?: boolean;
    org_id?: string;
  } = {},
) {
  const orgId = opts.org_id ?? BMH_ORG_ID;
  const phone = opts.phone_1 === undefined ? nextPhone() : opts.phone_1;
  const { data: contact, error: contactError } = await client
    .from("contacts")
    .insert({
      org_id: orgId,
      first_name: "Jitter",
      last_name: "Route",
      phone_1: phone,
      do_not_contact: opts.do_not_contact ?? false,
    })
    .select("id")
    .single();
  if (contactError || !contact) throw contactError ?? new Error("seed contact");

  const { data: property, error: propertyError } = await client
    .from("properties")
    .insert({
      org_id: orgId,
      address: `Jitter Route ${crypto.randomUUID()}`,
      state: opts.state ?? "MO",
      status: "prospect",
      homeowner_contact_id: contact.id,
    })
    .select("id")
    .single();
  if (propertyError || !property) throw propertyError ?? new Error("seed property");

  return {
    orgId,
    contactId: contact.id as string,
    propertyId: property.id as string,
    phoneE164: phone,
  };
}

export async function seedDialerBatch(client: SupabaseClient<any>) {
  const lead = await seedDialerLead(client);
  const { data: batch, error: batchError } = await (client as any)
    .from("dialer_batches")
    .insert({
      org_id: lead.orgId,
      title: "Route batch",
      source_kind: "selected_ids",
      source_meta: {},
    })
    .select("id")
    .single();
  if (batchError || !batch) throw batchError ?? new Error("seed batch");

  const { data: item, error: itemError } = await (client as any)
    .from("dialer_batch_items")
    .insert({
      batch_id: batch.id,
      property_id: lead.propertyId,
      contact_id: lead.contactId,
      phone_e164: lead.phoneE164,
      phone_label: "homeowner.phone_1",
      state: "MO",
      timezone: "America/Chicago",
    })
    .select("id")
    .single();
  if (itemError || !item) throw itemError ?? new Error("seed item");

  return { ...lead, batchId: batch.id as string, itemId: item.id as string };
}

export async function seedCallActivity(client: SupabaseClient<any>) {
  const seeded = await seedDialerBatch(client);
  const { data: activity, error } = await (client as any)
    .from("call_activities")
    .insert({
      org_id: seeded.orgId,
      property_id: seeded.propertyId,
      contact_id: seeded.contactId,
      dialer_batch_item_id: seeded.itemId,
      jitter_attempt_id: `attempt-${crypto.randomUUID()}`,
      provider: "jitter",
      outcome: "unknown",
    })
    .select("id, updated_at")
    .single();
  if (error || !activity) throw error ?? new Error("seed activity");

  return {
    ...seeded,
    callActivityId: activity.id as string,
    callActivityUpdatedAt: activity.updated_at as string,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
