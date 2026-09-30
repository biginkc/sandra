import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/types";
import {
  assertCanaryDispatchEligibility, assertCanaryReceipt, assertCentralSendWindow, assertDeliveryWebhook, assertFreshCanaryFixture,
  FIXTURE_ADDRESS, preflightFixture, RECEIVER_NUMBER, SENDILLO_SENDER,
} from "../../../scripts/sequence-canary-fixture";
import { runSequencePreflight, runSequenceSmoke } from "../../../scripts/smoke-sequences-prod";
import fs from "node:fs";

vi.mock("../../../scripts/sequence-canary-cleanup", () => ({
  cleanupAllCanaries: vi.fn(async () => 0),
  cleanupCanary: vi.fn(async () => undefined),
}));
vi.mock("../../../scripts/sequence-canary-runtime", () => ({
  inspectRuntime: vi.fn(() => ({ description: "test-runtime-proof" })),
}));

const ids = { userId: "11111111-1111-4111-8111-111111111111", propertyId: "22222222-2222-4222-8222-222222222222", contactId: "33333333-3333-4333-8333-333333333333" };
const org = "44444444-4444-4444-8444-444444444444";
const daytime = new Date("2026-09-29T15:00:00Z");

function fixtureClient(overrides: Record<string, unknown[]> = {}, errors: string[] = []) {
  const rows: Record<string, Record<string, unknown>[]> = {
    organizations: [{ id: org }],
    properties: [{ id: ids.propertyId, org_id: org, homeowner_contact_id: ids.contactId, address: FIXTURE_ADDRESS, state: "MO", ai_responder_disabled: true, skip_trace_disabled: true, outreach_dispo: null, is_dnc_locked: false, is_training: false, status: "new_lead", deleted_at: null }],
    contacts: [{ id: ids.contactId, org_id: org, first_name: "Sequence", last_name: "Canary", phone_1: RECEIVER_NUMBER, phone_1_type: "mobile", phone_2: null, phone_3: null, do_not_contact: false, sms_opted_out: false }],
    consent_events: [{ id: "consent", org_id: org, contact_id: ids.contactId, channel: "sms", event_type: "opt_in_marketing_written" }],
    property_contacts: [],
    sms_phone_suppressions: [],
  };
  for (const [key, value] of Object.entries(overrides)) rows[key] = value as Record<string, unknown>[];
  const queried: { table: string; filters: Record<string, unknown> }[] = [];
  const client = {
    auth: { admin: { getUserById: async () => ({ data: { user: { id: ids.userId } }, error: null }) } },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      queried.push({ table, filters });
      let ordering: { column: string; ascending: boolean } | null = null;
      let maxRows: number | null = null;
      const matching = () => {
        const found = rows[table]?.filter((row) => Object.entries(filters).every(([k, v]) => row[k] === v)) ?? [];
        if (ordering) found.sort((a, b) => String(a[ordering!.column]).localeCompare(String(b[ordering!.column])) * (ordering!.ascending ? 1 : -1));
        return maxRows === null ? found : found.slice(0, maxRows);
      };
      const result = (single: boolean) => ({ data: single ? matching()[0] ?? null : matching(), error: errors.includes(table) ? { message: "query failed" } : null });
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters[column] = value; return query; },
        order: (column: string, options: { ascending: boolean }) => { ordering = { column, ascending: options.ascending }; return query; },
        limit: (count: number) => { maxRows = count; return query; },
        maybeSingle: async () => result(true),
        then(resolve: (value: unknown) => unknown) { return Promise.resolve(resolve(result(false))); },
      };
      return query;
    },
  } as unknown as SupabaseClient<Database>;
  return { client, queried, rows };
}

describe("fresh provisioning", () => {
  it("refuses marker property, canary-created contact, and unexpected receiver contact", () => {
    expect(() => assertFreshCanaryFixture([], [{ id: ids.propertyId }])).toThrow("property");
    expect(() => assertFreshCanaryFixture([], [], [{ id: ids.contactId }])).toThrow("canary-created");
    expect(() => assertFreshCanaryFixture([{ id: ids.contactId }], [], [], "d158a56c-0000-4000-8000-000000000000")).toThrow("Unexpected contact");
    expect(() => assertFreshCanaryFixture([{ id: "d158a56c-0000-4000-8000-000000000000" }], [], [], "d158a56c-0000-4000-8000-000000000000")).not.toThrow();
    expect(() => assertFreshCanaryFixture([{ id: "d158a56c-0000-4000-8000-000000000001" }], [], [], "d158a56c-0000-4000-8000-000000000000")).toThrow("Unexpected contact");
  });
  it("provisioning sets the dedicated fixture fields and detects partial residue", () => {
    const source = fs.readFileSync("scripts/provision-sequence-canary.ts", "utf8");
    expect(source).toContain("RECEIVER_NUMBER");
    expect(source).toContain("ai_responder_disabled: true");
    expect(source).toContain("skip_trace_disabled: true");
    expect(source).toContain("assertFreshCanaryFixture(matchingContacts, properties ?? [], namedContacts ?? [], env.SEQUENCE_CANARY_VERIFICATION_CONTACT_ID)");
    expect(source).toContain("partial canary residue");
    expect(source).toContain('env.SEQUENCE_CANARY_CONSENT_APPROVED !== "true"');
    expect(source).not.toContain("TWILIO_NUMBER");
  });
});

describe("send eligibility", () => {
  it("accepts an isolated fixture and scopes suppression by org, channel, and number", async () => {
    const { client, queried } = fixtureClient();
    await expect(preflightFixture(client, ids, daytime)).resolves.toBe(org);
    expect(queried.find((query) => query.table === "sms_phone_suppressions")?.filters)
      .toEqual({ org_id: org, channel: "sms", phone_e164: RECEIVER_NUMBER });
  });
  it.each([
    ["wrong org", "properties", { org_id: "other" }],
    ["wrong address", "properties", { address: "other" }],
    ["wrong state", "properties", { state: "KS" }],
    ["AI enabled", "properties", { ai_responder_disabled: false }],
    ["skip trace enabled", "properties", { skip_trace_disabled: false }],
    ["nurture", "properties", { outreach_dispo: "nurture" }],
    ["terminal disposition", "properties", { outreach_dispo: "dnc" }],
    ["not new lead", "properties", { status: "won" }],
    ["training", "properties", { is_training: true }],
    ["deleted", "properties", { deleted_at: "2026-09-01" }],
    ["DNC lock", "properties", { is_dnc_locked: true }],
    ["wrong phone", "contacts", { phone_1: "+18165550123" }],
    ["non-mobile", "contacts", { phone_1_type: "landline" }],
    ["second phone", "contacts", { phone_2: "+18165550124" }],
    ["third phone", "contacts", { phone_3: "+18165550125" }],
    ["DNC", "contacts", { do_not_contact: true }],
    ["opted out", "contacts", { sms_opted_out: true }],
  ])("rejects %s", async (_label, table, patch) => {
    const { rows } = fixtureClient();
    const { client } = fixtureClient({ [table]: [{ ...rows[table][0], ...patch }] });
    await expect(preflightFixture(client, ids, daytime)).rejects.toThrow();
  });
  it("rejects suppression and suppression lookup error", async () => {
    await expect(preflightFixture(fixtureClient({ sms_phone_suppressions: [{ org_id: org, channel: "sms", phone_e164: RECEIVER_NUMBER }] }).client, ids, daytime)).rejects.toThrow("suppression");
    await expect(preflightFixture(fixtureClient({}, ["sms_phone_suppressions"]).client, ids, daytime)).rejects.toThrow("suppression");
  });
  it("rejects a different homeowner contact even when the fixture contact is otherwise valid", async () => {
    const { rows } = fixtureClient();
    const { client } = fixtureClient({ properties: [{ ...rows.properties[0], homeowner_contact_id: "other" }] });
    await expect(preflightFixture(client, ids, daytime)).rejects.toThrow("eligibility");
  });
  it("uses the newest SMS consent when an older opt-in precedes an opt-out", async () => {
    const { client } = fixtureClient({ consent_events: [
      { id: "old", org_id: org, contact_id: ids.contactId, channel: "sms", occurred_at: "2026-09-27T00:00:00Z", event_type: "opt_in_marketing_written" },
      { id: "new", org_id: org, contact_id: ids.contactId, channel: "sms", occurred_at: "2026-09-28T00:00:00Z", event_type: "opt_out" },
    ] });
    await expect(preflightFixture(client, ids, daytime)).rejects.toThrow("consent");
  });
  it("rejects revoked consent and another property relationship", async () => {
    await expect(preflightFixture(fixtureClient({ consent_events: [{ id: "latest", org_id: org, contact_id: ids.contactId, channel: "sms", event_type: "opt_out" }] }).client, ids, daytime)).rejects.toThrow("consent");
    await expect(preflightFixture(fixtureClient({ property_contacts: [{ contact_id: ids.contactId, property_id: "other" }] }).client, ids, daytime)).rejects.toThrow("relationship");
  });
  it("enforces Central weekdays and hours", () => {
    expect(() => assertCentralSendWindow(daytime)).not.toThrow();
    for (const time of ["2026-09-26T15:00:00Z", "2026-09-29T12:59:00Z", "2026-09-30T01:00:00Z"]) {
      expect(() => assertCentralSendWindow(new Date(time))).toThrow("send window");
    }
  });
  it("cleanup-only uses ownership, not send eligibility", () => {
    const source = fs.readFileSync("scripts/smoke-sequences-prod.ts", "utf8");
    expect(source.indexOf("await cleanupAllCanaries(supabase, ids.userId, ids.propertyId)")).toBeLessThan(source.indexOf("const orgId = await preflightFixture"));
    expect(source).not.toContain("cleanupOwnership");
  });
});

describe("run-specific Sendillo proof", () => {
  const body = "Mel with BMH. PROD-SMOKE unique - Reply STOP.";
  const good = { id: "m", body, to_address: RECEIVER_NUMBER, from_address: SENDILLO_SENDER, provider: "sendillo", external_id: "snd123", status: "delivered", sent_at: "2026-09-29T15:00:00Z", delivered_at: "2026-09-29T15:00:01Z" };
  it("requires exact delivered message fields", () => {
    expect(assertCanaryReceipt(good, body)).toBe("m");
    for (const patch of [{ body: "other" }, { to_address: "other" }, { from_address: "other" }, { provider: "twilio" }, { external_id: null }, { status: "sent" }, { sent_at: null }, { delivered_at: null }]) {
      expect(() => assertCanaryReceipt({ ...good, ...patch }, body)).toThrow();
    }
  });
  it("requires the exact authenticated processed delivery webhook", () => {
    const event = { id: "w", provider: "sendillo", external_id: "snd123", event_type: "sms_status_delivered", signature_verified: true, processing_status: "processed" };
    expect(assertDeliveryWebhook(event, "snd123")).toBe("w");
    for (const patch of [{ provider: "twilio" }, { external_id: "other" }, { event_type: "other" }, { signature_verified: false }, { processing_status: "pending" }]) {
      expect(() => assertDeliveryWebhook({ ...event, ...patch }, "snd123")).toThrow();
    }
  });
  it("rejects wrong sender before a sequence write", async () => {
    const { client } = fixtureClient();
    await expect(runSequenceSmoke(client, ids, false, "")).rejects.toThrow();
  });
  it("has bounded waits and records all proof before cleanup", () => {
    const source = fs.readFileSync("scripts/smoke-sequences-prod.ts", "utf8");
    expect(source).toContain("12 * 60_000");
    expect(source).toContain("2 * 60_000");
    expect(source).toContain("3 * 60_000");
    expect(source).toContain("enrollmentId: enrollment.id, stepId: step.id, claimId: claim.id");
    expect(source).toContain("webhookEventId: webhook.id");
    expect(source.indexOf("webhookEventId: webhook.id")).toBeLessThan(source.indexOf("await cleanupCanary"));
    expect(source).not.toContain("test_sms_log");
  });
  it("rechecks canary eligibility at both provider dispatch sites", () => {
    const source = fs.readFileSync("src/lib/messaging/send.ts", "utf8");
    expect(source.match(/await assertCanaryDispatchEligibility\(/g)).toHaveLength(2);
    expect(source.indexOf("await assertCanaryDispatchEligibility(", source.indexOf("export async function sendSmsToContact")))
      .toBeLessThan(source.indexOf("const result = await provider.sendSms(", source.indexOf("export async function sendSmsToContact")));
    expect(source.indexOf("await assertCanaryDispatchEligibility(", source.indexOf("export async function releaseQueuedMessage")))
      .toBeLessThan(source.indexOf("const result = await provider.sendSms(", source.indexOf("export async function releaseQueuedMessage")));
    expect(source.match(/await assertCanarySendBinding\(/g)).toHaveLength(2);
    expect(source.indexOf("await assertCanarySendBinding(", source.indexOf("export async function sendSmsToContact")))
      .toBeLessThan(source.indexOf("const result = await provider.sendSms(", source.indexOf("export async function sendSmsToContact")));
    expect(source.indexOf("await assertCanarySendBinding(", source.indexOf("export async function releaseQueuedMessage")))
      .toBeLessThan(source.indexOf("const result = await provider.sendSms(", source.indexOf("export async function releaseQueuedMessage")));
  });
  it("dispatch guard fails closed on sender, identity, or fixture changes", async () => {
    vi.stubEnv("SEQUENCE_CANARY_USER_ID", ids.userId);
    vi.stubEnv("SEQUENCE_CANARY_PROPERTY_ID", ids.propertyId);
    vi.stubEnv("SEQUENCE_CANARY_CONTACT_ID", ids.contactId);
    try {
      const input = { propertyId: ids.propertyId, contactId: ids.contactId, to: RECEIVER_NUMBER,
        from: SENDILLO_SENDER, provider: "sendillo", body: "PROD-SMOKE run" };
      vi.useFakeTimers();
      vi.setSystemTime(daytime);
      await expect(assertCanaryDispatchEligibility(fixtureClient().client, { ...input, from: "other" }))
        .rejects.toThrow("sender mismatch");
      await expect(assertCanaryDispatchEligibility(fixtureClient().client, { ...input, contactId: "other" }))
        .rejects.toThrow("identity");
      await expect(assertCanaryDispatchEligibility(fixtureClient().client, { ...input, provider: "twilio" }))
        .rejects.toThrow("sender mismatch");
      const { rows } = fixtureClient();
      await expect(assertCanaryDispatchEligibility(fixtureClient({ properties: [{ ...rows.properties[0], state: "KS" }] }).client, input))
        .rejects.toThrow("eligibility");
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
  it.each(["failed claim", "failed message", "delivery timeout"])("logs known IDs before cleanup on %s", async (failure) => {
    vi.useFakeTimers();
    vi.setSystemTime(daytime);
    const { client } = fixtureClient();
    const originalFrom = client.from.bind(client);
    const message = { id: "message-id", body: "", to_address: RECEIVER_NUMBER, from_address: SENDILLO_SENDER,
      provider: "sendillo", external_id: "external-id", status: failure === "failed message" ? "failed" : "sent",
      sent_at: failure === "delivery timeout" ? "2026-09-29T14:56:00Z" : daytime.toISOString(), delivered_at: null };
    const fake = {
      ...client,
      from(table: string) {
        if (!["sequences", "sequence_steps", "sequence_enrollments", "sequence_step_runs", "messages"].includes(table)) return originalFrom(table as "properties");
        const row = table === "sequences" ? { id: "sequence-id" } : table === "sequence_steps" ? { id: "step-id" } :
          table === "sequence_enrollments" ? { id: "enrollment-id" } : table === "sequence_step_runs" ?
            { id: "claim-id", message_id: "message-id", attempt_outcome: failure === "failed claim" ? "failed" : "accepted" } : message;
        const query = {
          insert: () => query, select: () => query, eq: () => query, limit: () => query,
          single: async () => ({ data: row, error: null }),
          then(resolve: (value: unknown) => unknown) { return Promise.resolve(resolve({ data: [row], error: null })); },
        };
        return query;
      },
    } as unknown as SupabaseClient<Database>;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.map(String).join(" ")); });
    try {
      await expect(runSequenceSmoke(fake, ids, false, SENDILLO_SENDER, {
        approvedKey: "test", adminAccessToken: "test", deploymentUrl: "https://test.example",
        aliasHost: "test.example", expectedCommitSha: "a".repeat(40),
        runId: "12345", runMode: "manual",
      })).rejects.toThrow();
      const finalEvidence = logs.find((line) => line.startsWith("[smoke] evidence before cleanup"));
      expect(finalEvidence).toBeDefined();
      const evidence = JSON.parse(finalEvidence!.slice("[smoke] evidence before cleanup ".length));
      expect(evidence.claimId).toBe("claim-id");
      expect(evidence.messageId).toBe("message-id");
      expect(evidence.externalId).toBe(failure === "failed claim" ? null : "external-id");
      expect(evidence.status).toBe(failure === "failed claim" ? "failed" : failure === "failed message" ? "failed" : "sent");
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

it("preflight-only selects reference rows without any insert or enrollment", async () => {
  const tables: string[] = [];
  const client = { from(table: string) {
    tables.push(table);
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { id: "existing" }, error: null }) };
    return query;
  } } as unknown as SupabaseClient<Database>;
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runSequencePreflight(client, "https://copflsklaefwzipsrjqz.supabase.co", ids.userId, ids.contactId);
    expect(tables).toEqual(["messages", "webhook_events"]);
  } finally { log.mockRestore(); }
});

it("workflow gates schedule and gives cleanup its own timeout", () => {
  const workflow = fs.readFileSync(".github/workflows/canary-sequences.yml", "utf8");
  expect(workflow).toMatch(/if:\s*\$\{\{\s*github\.event_name != 'schedule' \|\| vars\.SEQUENCE_CANARY_SCHEDULE_ENABLED == 'true'\s*\}\}/);
  expect(workflow).toContain("npx tsx scripts/check-sequence-canary-failure-latch.ts");
  expect(workflow).toContain("preflight-only");
  expect(workflow).toContain("cancel-in-progress: false");
  expect(workflow).toContain("queue: max");
  expect(workflow).toContain('cron: "17 14 * * 1-5"');
  expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
  expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
  expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
  expect(workflow).toContain("Missing required inputs:");
  expect(workflow).toContain("Recheck current canary authorization");
  expect(workflow).toContain("Scheduled send window elapsed");
  expect(workflow).toContain("retention-days: 90");
  expect(workflow).toContain("timeout-minutes: 35");
  expect(workflow).toMatch(/Clean up tagged canary data[\s\S]*if: always\(\)[\s\S]*timeout-minutes: 5/);
  expect(workflow).not.toContain("Twilio");
  expect(workflow).not.toContain("test_sms_log");
});
