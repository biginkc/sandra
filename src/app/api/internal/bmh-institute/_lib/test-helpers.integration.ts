import { createHash, createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { BMH_ORG_ID, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

export const INSTITUTE_TOKEN = "institute-route-integration-token";

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sign(body: string): string {
  return "sha256=" + createHmac("sha256", INSTITUTE_TOKEN).update(body).digest("hex");
}

export function authHeaders(body: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${INSTITUTE_TOKEN}`,
    "x-sandra-signature": sign(body),
    ...extra,
  };
}

export function jsonRequest(
  url: string,
  method: "PUT",
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

export async function resetInstituteIntegration(client: SupabaseClient<any>) {
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
    consumer_type: "bmh_institute_course",
    name: "bmh-institute-route-tests",
    secret_hash: hashSecret(INSTITUTE_TOKEN),
    enabled: true,
  });
  if (error) {
    throw new Error(`seed institute webhook consumer failed: ${error.message}`);
  }
}
