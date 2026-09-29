import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/types";
import { assertFreshCanaryFixture, assertCanaryReceipt, preflightFixture, TWILIO_NUMBER } from "../../../scripts/sequence-canary-fixture";
import { runSequenceSmoke } from "../../../scripts/smoke-sequences-prod";
import fs from "node:fs";

const ids = { userId: "11111111-1111-4111-8111-111111111111", propertyId: "22222222-2222-4222-8222-222222222222", contactId: "33333333-3333-4333-8333-333333333333" };
const org = "44444444-4444-4444-8444-444444444444";
function fixtureClient(overrides: Record<string, unknown> = {}) {
  const rows: Record<string, unknown[]> = {
    properties: [{ id: ids.propertyId, org_id: org, homeowner_contact_id: ids.contactId, is_dnc_locked: false, is_training: false, status: "new_lead", deleted_at: null }],
    contacts: [{ id: ids.contactId, org_id: org, phone_1: TWILIO_NUMBER, phone_1_type: "mobile", phone_2: null, phone_3: null, do_not_contact: false, sms_opted_out: false }],
    consent_events: [{ id: "consent", org_id: org, contact_id: ids.contactId, channel: "sms", event_type: "opt_in_marketing_written" }],
    property_contacts: [],
  };
  for (const [key, value] of Object.entries(overrides)) rows[key] = value as unknown[];
  const client = {
    auth: { admin: { getUserById: async () => ({ data: { user: { id: ids.userId } }, error: null }) } },
    from(table: string) {
      const filters: Record<string, string> = {};
      const query = {
        select: () => query,
        eq: (column: string, value: string) => { filters[column] = value; return query; },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: rows[table]?.find((row) => Object.entries(filters).every(([k, v]) => (row as Record<string, unknown>)[k] === v)) ?? null, error: null }),
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(resolve({ data: rows[table]?.filter((row) => Object.entries(filters).every(([k, v]) => (row as Record<string, unknown>)[k] === v)) ?? [], error: null }));
        },
      };
      return query;
    },
  } as unknown as SupabaseClient<Database>;
  return client;
}

describe("fresh canary provisioning", () => {
  it.each([
    [[{ id: ids.contactId }], [], "contact"],
    [[], [{ id: ids.propertyId }], "property"],
  ])("refuses existing %s before writes", (contacts, properties, label) => {
    expect(() => assertFreshCanaryFixture(contacts, properties)).toThrow(label);
  });
  it("checks all matching identifiers and invokes the guard before the first insert", () => {
    const source = fs.readFileSync("scripts/provision-sequence-canary.ts", "utf8");
    expect(source).toContain("phone_1.eq.${TWILIO_NUMBER},phone_2.eq.${TWILIO_NUMBER},phone_3.eq.${TWILIO_NUMBER}");
    expect(source).toContain('.eq("first_name", "Sequence").eq("last_name", "Canary")');
    expect(source.indexOf("assertFreshCanaryFixture(matchingContacts, properties ?? [])"))
      .toBeLessThan(source.indexOf('.from("contacts").insert('));
  });
});

describe("canary fixture preflight", () => {
  it("accepts an isolated eligible fixture", async () => {
    await expect(preflightFixture(fixtureClient(), ids)).resolves.toBe(org);
  });
  it.each([
    ["wrong primary phone", { phone_1: "+18165550123" }],
    ["non-mobile primary phone", { phone_1_type: "landline" }],
    ["second phone", { phone_2: "+18165550124" }],
    ["third phone", { phone_3: "+18165550125" }],
    ["DNC", { do_not_contact: true }],
    ["opted out", { sms_opted_out: true }],
  ])("rejects %s", async (_label, patch) => {
    const base = (await fixtureClient().from("contacts").select("*").eq("id", ids.contactId).maybeSingle()).data!;
    await expect(preflightFixture(fixtureClient({ contacts: [{ ...base, ...patch }] }), ids)).rejects.toThrow();
  });
  it("rejects latest revoked consent", async () => {
    await expect(preflightFixture(fixtureClient({ consent_events: [{ id: "latest", org_id: org, contact_id: ids.contactId, channel: "sms", event_type: "opt_out" }] }), ids)).rejects.toThrow();
  });
  it("rejects another homeowner property", async () => {
    const base = (await fixtureClient().from("properties").select("*").eq("id", ids.propertyId).maybeSingle()).data!;
    await expect(preflightFixture(fixtureClient({ properties: [base, { ...base, id: "other" }] }), ids)).rejects.toThrow();
  });
  it("rejects another agent property", async () => {
    const base = (await fixtureClient().from("properties").select("*").eq("id", ids.propertyId).maybeSingle()).data!;
    await expect(preflightFixture(fixtureClient({ properties: [base, { ...base, id: "other", homeowner_contact_id: null, agent_contact_id: ids.contactId }] }), ids)).rejects.toThrow();
  });
  it("rejects another property_contacts relationship", async () => {
    await expect(preflightFixture(fixtureClient({ property_contacts: [{ contact_id: ids.contactId, property_id: "other", org_id: org }] }), ids)).rejects.toThrow();
  });
});

describe("run-specific receipt", () => {
  const body = "Mel with BMH. PROD-SMOKE unique - Reply STOP.";
  const good = { id: "receipt", body, to_number: TWILIO_NUMBER, from_number: "+18162804181", provider: "twilio", external_id: "SM123", signature_verified: true, received_at: "2026-09-29T12:00:00Z" };
  it("accepts exact row and records its id", () => expect(assertCanaryReceipt(good, body, "+18162804181")).toBe("receipt"));
  it.each([
    ["body", { body: "another run" }], ["receiver", { to_number: "+18165550123" }],
    ["sender", { from_number: "+18165550123" }], ["SID", { external_id: null }],
    ["provider", { provider: "other" }], ["signature", { signature_verified: false }],
  ])("rejects mismatched %s on the matched row", (_label, patch) => {
    expect(() => assertCanaryReceipt({ ...good, ...patch }, body, "+18162804181")).toThrow();
  });
  it("requires an expected sender before creating a sequence", async () => {
    const writes: string[] = [];
    const client = fixtureClient();
    const originalFrom = client.from.bind(client);
    client.from = ((table: "sequences") => {
      if (table === "sequences") writes.push(table);
      return originalFrom(table);
    }) as typeof client.from;
    await expect(runSequenceSmoke(client, ids, false, "")).rejects.toThrow("SEQUENCE_CANARY_EXPECTED_SENDER");
    expect(writes).toEqual([]);
  });
  it("checks the row selected by the run token and prints its exact body and row id", () => {
    const source = fs.readFileSync("scripts/smoke-sequences-prod.ts", "utf8");
    expect(source).toContain("assertCanaryReceipt(matched, sentBody, expectedSender)");
    expect(source).toContain("sent body = ${sentBody}");
    expect(source).toContain("test_sms_log row ${matchedRowId}");
  });
});

it("schedule is disabled by default while manual dispatch remains available", () => {
  const workflow = fs.readFileSync(".github/workflows/canary-sequences.yml", "utf8");
  expect(workflow).toMatch(/if:\s*\$\{\{\s*github\.event_name != 'schedule' \|\| vars\.SEQUENCE_CANARY_SCHEDULE_ENABLED == 'true'\s*\}\}/);
  expect(workflow).toMatch(/concurrency:\s*\n\s*group:.*\n\s*cancel-in-progress: false/);
  expect(workflow).toContain("workflow_dispatch: {}");
});
