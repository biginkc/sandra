import { createHash, createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { BMH_ORG_ID, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

export const CLOSER_TOKEN = "closer-route-integration-token";

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sign(body: string): string {
  return "sha256=" + createHmac("sha256", CLOSER_TOKEN).update(body).digest("hex");
}

export function authHeaders(body: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${CLOSER_TOKEN}`,
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

export async function resetCloserIntegration(client: SupabaseClient<any>) {
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
  const { error } = await client.from("webhook_consumers").insert({
    org_id: BMH_ORG_ID,
    consumer_type: "closer_practice",
    name: "closer-route-tests",
    secret_hash: hashSecret(CLOSER_TOKEN),
    enabled: true,
  });
  if (error) {
    throw new Error(`seed closer webhook consumer failed: ${error.message}`);
  }
}

export async function seedLead(client: SupabaseClient<any>) {
  const { data: contact, error: contactError } = await client
    .from("contacts")
    .insert({
      org_id: BMH_ORG_ID,
      first_name: "Closer",
      last_name: "Practice",
      phone_1: `+1816777${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`,
    })
    .select("id")
    .single();
  if (contactError || !contact) throw contactError ?? new Error("seed contact");

  const { data: property, error: propertyError } = await client
    .from("properties")
    .insert({
      org_id: BMH_ORG_ID,
      address: `Closer Practice ${crypto.randomUUID()}`,
      state: "MO",
      status: "prospect",
      homeowner_contact_id: contact.id,
    })
    .select("id")
    .single();
  if (propertyError || !property) throw propertyError ?? new Error("seed property");

  return {
    orgId: BMH_ORG_ID,
    contactId: contact.id as string,
    propertyId: property.id as string,
  };
}
