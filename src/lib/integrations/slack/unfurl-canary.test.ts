import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  attemptFacts: [{
    latest_attempt_id: "00000000-0000-0000-0000-000000000007",
    latest_attempt_outcome: "reached",
    reached_call_id: "00000000-0000-0000-0000-000000000009",
    reached_call_occurred_at: "2026-10-04T12:00:00.000Z",
  }] as Array<{
    latest_attempt_id: string | null;
    latest_attempt_outcome: string | null;
    reached_call_id: string | null;
    reached_call_occurred_at: string | null;
  }>,
}));

function makeQuery(table: string) {
  const filters = new Map<string, unknown>();
  let limited = false;
  const query = {
    select: () => query,
    eq: (column: string, value: unknown) => {
      filters.set(column, value);
      return query;
    },
    is: () => query,
    or: () => query,
    limit: (count: number) => {
      limited = true;
      const rows = state.tables[table] ?? [];
      query.result = rows.slice(0, count).filter((row) => {
        if (!row || typeof row !== "object") return false;
        const candidate = row as Record<string, unknown>;
        return [...filters.entries()].every(([key, value]) => candidate[key] === value);
      });
      return query;
    },
    result: [] as unknown[],
    then(resolve: (value: { data: unknown; error: null }) => unknown) {
      const rows = limited ? query.result : state.tables[table] ?? [];
      return Promise.resolve(resolve({ data: rows, error: null }));
    },
  };
  return query;
}

const client = {
  from: (table: string) => makeQuery(table),
  rpc: () => Promise.resolve({ data: state.attemptFacts, error: null }),
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => client) }));

import { verifySlackCanaryFixture } from "./unfurl-canary";

const RUN_ID = "00000000-0000-0000-0000-000000000001";
const PROPERTY_ID = "00000000-0000-0000-0000-000000000004";
const CONTACT_ID = "00000000-0000-0000-0000-000000000008";
const ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const job = { org_id: ORG_ID } as never;

function seed() {
  const marker = `slack-canary:${RUN_ID}`;
  state.tables = {
    properties: [{ id: PROPERTY_ID, org_id: ORG_ID, homeowner_contact_id: CONTACT_ID, notes: marker, deleted_at: null }],
    contacts: [{ id: CONTACT_ID, org_id: ORG_ID, first_name: "Synthetic", last_name: "Canary", entity_name: null, notes: marker, phone_1: null, phone_2: null, phone_3: null }],
    messages: [
      { id: "m1", org_id: ORG_ID, channel: "sms", property_id: PROPERTY_ID, contact_id: null, metadata: { canaryRunId: RUN_ID } },
      { id: "m2", org_id: ORG_ID, channel: "sms", property_id: PROPERTY_ID, contact_id: null, metadata: { canaryRunId: RUN_ID } },
      { id: "m3", org_id: ORG_ID, channel: "sms", property_id: null, contact_id: CONTACT_ID, metadata: { canaryRunId: RUN_ID } },
    ],
    rep_sms_obligations: [],
    rep_sms_delivery_ledger: [],
    dialpad_call_intents: [],
  };
}

beforeEach(() => {
  seed();
  state.attemptFacts = [{
    latest_attempt_id: "00000000-0000-0000-0000-000000000007",
    latest_attempt_outcome: "reached",
    reached_call_id: "00000000-0000-0000-0000-000000000009",
    reached_call_occurred_at: "2026-10-04T12:00:00.000Z",
  }];
});

describe("run-owned Slack canary fixture proof", () => {
  it("accepts marker-owned no-phone history with one recorded attempt", async () => {
    await expect(verifySlackCanaryFixture({ job, runId: RUN_ID, propertyId: PROPERTY_ID })).resolves.toBe(true);
  });

  it("rejects a phone-bearing contact before any worker can run", async () => {
    state.tables.contacts![0] = { ...(state.tables.contacts![0] as object), phone_1: "+15555550123" };
    await expect(verifySlackCanaryFixture({ job, runId: RUN_ID, propertyId: PROPERTY_ID })).resolves.toBe(false);
  });

  it.each(["rep_sms_obligations", "rep_sms_delivery_ledger", "dialpad_call_intents"])("rejects a fixture with a provider safety row in %s", async (table) => {
    state.tables[table] = [{ id: "provider-row", org_id: ORG_ID, property_id: PROPERTY_ID }];
    await expect(verifySlackCanaryFixture({ job, runId: RUN_ID, propertyId: PROPERTY_ID })).resolves.toBe(false);
  });

  it("rejects history that is not exactly three rows bound to the owned property/contact", async () => {
    state.tables.messages = state.tables.messages.slice(0, 2);
    await expect(verifySlackCanaryFixture({ job, runId: RUN_ID, propertyId: PROPERTY_ID })).resolves.toBe(false);
  });

  it("rejects a property or contact without this run marker", async () => {
    state.tables.properties![0] = { ...(state.tables.properties![0] as object), notes: "ordinary property" };
    await expect(verifySlackCanaryFixture({ job, runId: RUN_ID, propertyId: PROPERTY_ID })).resolves.toBe(false);
  });

  it("rejects a fixture without a reached recorded attempt", async () => {
    state.attemptFacts[0] = { ...state.attemptFacts[0], latest_attempt_outcome: "no_answer", reached_call_id: null, reached_call_occurred_at: null };
    await expect(verifySlackCanaryFixture({ job, runId: RUN_ID, propertyId: PROPERTY_ID })).resolves.toBe(false);
  });
});
