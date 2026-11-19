import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MOCK_SENDER_PRIMARY, seedSenderCatalog } from "@tests/integration/delivery";
import { handleInboundWebhook } from "@/lib/messaging/inbound";
import { MockMessagingProvider, resetMockState } from "@/lib/messaging/providers/mock";
import type { Database } from "@/lib/supabase/types";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

/**
 * Delayed-reply inbound path vs. a property whose responder a person turned off
 * (Messages v2 redesign, PR 2). Real handleInboundWebhook, mock SMS provider, a
 * 30-60s reply delay configured. Local only. Everything runs in one temporary
 * organization this file creates and removes; tenant tables are never reset.
 *
 * Rule (dispatch.ts step 2): responder off for the property = no Sandra keyword
 * hold and no alert, on the delayed path the same as the normal path.
 */
vi.mock("@/lib/messaging/quiet-hours", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours")>()),
  checkQuietHours: () => ({ ok: true, localTime: "12:00", zone: "America/Chicago" }),
}));
vi.mock("@/lib/messaging/quiet-hours-recipient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours-recipient")>()),
  checkRecipientQuietHours: () => ({ ok: true, state: "MO", localTime: "12:00", florida: false }),
}));
// A non-keyword text goes to the delay workflow; never start a real one.
vi.mock("workflow/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow/api")>()),
  start: async () => ({ runId: `delayed-path-${randomUUID()}` }),
}));

const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const admin = createClient<Database>(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const realFetch = globalThis.fetch;
const realEnv = { provider: process.env.MESSAGING_PROVIDER, typesafe: process.env.TYPESAFE_API_KEY };
let orgId = "";

beforeAll(async () => {
  assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
  await pg.connect();
  process.env.MESSAGING_PROVIDER = "mock";
  process.env.TYPESAFE_API_KEY = "stub-key";
  // No paid or external call: any non-loopback HTTP fails the suite.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`unexpected outbound HTTP: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;

  orgId = randomUUID();
  const { error: orgError } = await admin.from("organizations").insert({ id: orgId, name: `delayed-path ${orgId}` });
  expect(orgError).toBeNull();
  await seedSenderCatalog(admin, orgId, [MOCK_SENDER_PRIMARY]);
  const { error: configError } = await admin.from("ai_responder_configs").insert({
    org_id: orgId,
    system_prompt: "delayed path responder off",
    business_hours_only: false,
    classifier_provider: "jev",
    classifier_mode: "automatic",
    reply_delay_min_seconds: 30,
    reply_delay_max_seconds: 60,
  });
  expect(configError).toBeNull();
}, 60_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (realEnv.provider === undefined) delete process.env.MESSAGING_PROVIDER;
  else process.env.MESSAGING_PROVIDER = realEnv.provider;
  if (realEnv.typesafe === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = realEnv.typesafe;
  try {
    if (orgId) {
      // Temp-org rows only, from every public table that carries org_id.
      const { rows } = await pg.query<{ table_name: string }>(
        "select c.table_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name where c.table_schema = 'public' and c.column_name = 'org_id' and t.table_type = 'BASE TABLE'",
      );
      await pg.query("begin");
      await pg.query("set local session_replication_role = replica");
      for (const { table_name } of rows) {
        if (table_name === "organizations") continue;
        await pg.query(`delete from public."${table_name}" where org_id = $1`, [orgId]);
      }
      await pg.query("delete from public.organizations where id = $1", [orgId]);
      await pg.query("commit");
    }
  } catch (error) {
    await pg.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await pg.end();
  }
}, 60_000);

beforeEach(() => {
  resetMockState();
});

async function seedLead(opts: { disabled?: boolean } = {}) {
  // Unique phone per lead so the inbound resolves to this temp org only.
  const phone = `+1816${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .insert({ org_id: orgId, first_name: "Delayed", last_name: "Seller", phone_1: phone, phone_1_type: "mobile" })
    .select("id")
    .single();
  expect(contactError).toBeNull();
  await admin.from("consent_events").insert({ contact_id: contact!.id, channel: "sms", event_type: "opt_in_marketing_written", source: "delayed-path-test", org_id: orgId });
  const { data: property, error } = await admin
    .from("properties")
    .insert({ org_id: orgId, address: "DELAYED 123 Oak St", state: "MO", status: "prospect", homeowner_contact_id: contact!.id, ...(opts.disabled ? { ai_responder_disabled: true } : {}) })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { propertyId: property!.id, phone };
}

function webhook(from: string, body: string) {
  return handleInboundWebhook(
    new Request("https://example.test/webhooks/mock", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mock-signature": "valid" },
      body: JSON.stringify({ externalId: `delayed-path-${randomUUID()}`, from, to: MOCK_SENDER_PRIMARY, body }),
    }),
    { includeFullUrl: false, provider: new MockMessagingProvider() },
  );
}

async function propertyRow(propertyId: string) {
  const { data, error } = await admin.from("properties").select("needs_human_attention, last_ai_escalation_reason").eq("id", propertyId).single();
  expect(error).toBeNull();
  return data!;
}

describe("delayed-reply inbound path (real handleInboundWebhook, mock provider, delay configured)", () => {
  // Control: proves the delayed path's keyword gate runs in this fixture.
  it("control: responder-on property + 'talk to my lawyer' is held keyword:legal_contract", async () => {
    const lead = await seedLead();
    const res = await webhook(lead.phone, "You can talk to my lawyer about it");
    expect(res.status).toBe(200);
    expect(await propertyRow(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "keyword:legal_contract" });
  });

  it("responder-off property + the same text writes no hold", async () => {
    const lead = await seedLead({ disabled: true });
    const res = await webhook(lead.phone, "You can talk to my lawyer about it");
    expect(res.status).toBe(200);
    const prop = await propertyRow(lead.propertyId);
    expect(prop.needs_human_attention).toBe(false);
    expect(prop.last_ai_escalation_reason).toBeNull();
  });
});
