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

export async function insertCanaryProspect(
  client: SupabaseClient<Database>,
  input: { address: string; runId: string },
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
    })
    .select("id, address")
    .single();
  if (error || !data) {
    throw error ?? new Error("Could not insert canary prospect.");
  }
  return { id: data.id, address: data.address };
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
