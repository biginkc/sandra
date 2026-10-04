import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  queryCalls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  rpcCalls: [] as Array<{ functionName: string; args: Record<string, unknown> }>,
  rpcError: false,
  providerSafe: true,
  attemptFacts: [{
    latest_attempt_id: "00000000-0000-0000-0000-000000000007",
    latest_attempt_outcome: "reached",
  }] as Array<{
    latest_attempt_id: string | null;
    latest_attempt_outcome: string | null;
  }>,
}));

function makeQuery(table: string) {
  const filters = new Map<string, unknown>();
  const nullFilters = new Map<string, null>();
  let orFilter: string | null = null;
  let limited = false;
  const matches = (row: unknown): boolean => {
    if (!row || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    if (![...filters.entries()].every(([key, value]) => candidate[key] === value)) return false;
    if (![...nullFilters.keys()].every((key) => candidate[key] === null)) return false;
    if (orFilter) {
      const parsed = /^property_id\.eq\.([^,]+),and\(property_id\.is\.null,contact_id\.eq\.([^)]+)\)$/.exec(orFilter);
      if (!parsed || (candidate.property_id !== parsed[1] && !(candidate.property_id === null && candidate.contact_id === parsed[2]))) return false;
    }
    return true;
  };
  const query = {
    select: (columns: string) => {
      state.queryCalls.push({ table, method: "select", args: [columns] });
      return query;
    },
    eq: (column: string, value: unknown) => {
      state.queryCalls.push({ table, method: "eq", args: [column, value] });
      filters.set(column, value);
      return query;
    },
    is: (column: string, value: null) => {
      state.queryCalls.push({ table, method: "is", args: [column, value] });
      nullFilters.set(column, value);
      return query;
    },
    or: (filters: string) => {
      state.queryCalls.push({ table, method: "or", args: [filters] });
      orFilter = filters;
      return query;
    },
    limit: (count: number) => {
      state.queryCalls.push({ table, method: "limit", args: [count] });
      limited = true;
      const rows = state.tables[table] ?? [];
      query.result = rows.filter(matches).slice(0, count);
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
  rpc: (functionName: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ functionName, args });
    if (state.rpcError && functionName === "get_slack_canary_provider_safety") {
      return Promise.resolve({ data: null, error: { message: "rpc unavailable" } });
    }
    return Promise.resolve({
      data: functionName === "get_slack_preview_attempt_facts" ? state.attemptFacts : state.providerSafe,
      error: null,
    });
  },
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => client) }));

import { freezeSlackCanaryPreview, verifySlackCanaryFixture } from "./unfurl-canary";

const RUN_ID = "00000000-0000-0000-0000-000000000001";
const PROPERTY_ID = "00000000-0000-0000-0000-000000000004";
const CONTACT_ID = "00000000-0000-0000-0000-000000000008";
const ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const job = { org_id: ORG_ID } as never;

function seed() {
  const marker = `SLACK PREVIEW CANARY ${RUN_ID}`;
  state.tables = {
    properties: [{ id: PROPERTY_ID, org_id: ORG_ID, homeowner_contact_id: CONTACT_ID, notes: `${marker}; synthetic only; no seller contact`, deleted_at: null }],
    contacts: [{ id: CONTACT_ID, org_id: ORG_ID, first_name: "Synthetic", last_name: "Canary", entity_name: null, notes: `${marker}; synthetic only; no phone; no outreach`, phone_1: null, phone_2: null, phone_3: null }],
    messages: [
      { id: "foreign", org_id: "other-org", channel: "email", property_id: "other-property", contact_id: "other-contact", metadata: { canaryRunId: RUN_ID } },
      { id: "m1", org_id: ORG_ID, channel: "sms", property_id: PROPERTY_ID, contact_id: CONTACT_ID, metadata: { canaryRunId: RUN_ID } },
      { id: "m2", org_id: ORG_ID, channel: "sms", property_id: PROPERTY_ID, contact_id: CONTACT_ID, metadata: { canaryRunId: RUN_ID } },
      { id: "m3", org_id: ORG_ID, channel: "sms", property_id: null, contact_id: CONTACT_ID, metadata: { canaryRunId: RUN_ID } },
    ],
    rep_sms_obligations: [],
    rep_sms_delivery_ledger: [],
    dialpad_call_intents: [],
  };
}

beforeEach(() => {
  seed();
  state.queryCalls = [];
  state.rpcCalls = [];
  state.rpcError = false;
  state.attemptFacts = [{
    latest_attempt_id: "00000000-0000-0000-0000-000000000007",
    latest_attempt_outcome: "reached",
  }];
  state.providerSafe = true;
});

describe("run-owned Slack canary fixture proof", () => {
  it("freezes every server-captured render fact", () => {
    const snapshot = {
      propertyId: PROPERTY_ID,
      leadName: "Synthetic",
      address: "Canary Lane",
      ownerName: "Owner",
      ownerAssigned: true,
      latestAttempt: { id: "attempt", occurredAt: "2026-10-04T12:00:00.000Z", outcome: "reached" },
      messagesDisposition: "not_interested",
      lastContactAt: null,
      timezone: "America/Chicago",
      messages: [{ id: "message", createdAt: "2026-10-04T12:00:00.000Z", body: "synthetic", direction: "inbound" as const, deliveryStatus: "received", attachmentCount: 0 }],
    };
    const frozen = freezeSlackCanaryPreview(snapshot);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.latestAttempt)).toBe(true);
    expect(Object.isFrozen(frozen.messages)).toBe(true);
    expect(Object.isFrozen(frozen.messages[0])).toBe(true);
  });

  it("accepts marker-owned no-phone history with one recorded attempt", async () => {
    await expect(verifySlackCanaryFixture({ job, runId: RUN_ID, propertyId: PROPERTY_ID })).resolves.toBe(true);
    expect(state.queryCalls).toContainEqual({ table: "properties", method: "is", args: ["deleted_at", null] });
    expect(state.queryCalls).toContainEqual({
      table: "messages",
      method: "or",
      args: [`property_id.eq.${PROPERTY_ID},and(property_id.is.null,contact_id.eq.${CONTACT_ID})`],
    });
    expect(state.rpcCalls).toContainEqual({
      functionName: "get_slack_canary_provider_safety",
      args: { p_org_id: ORG_ID, p_property_id: PROPERTY_ID, p_contact_id: CONTACT_ID, p_run_id: RUN_ID },
    });
    expect(state.rpcCalls).toContainEqual({
      functionName: "get_slack_preview_attempt_facts",
      args: { p_org_id: ORG_ID, p_property_id: PROPERTY_ID },
    });
  });

  it("rejects a phone-bearing contact before any worker can run", async () => {
    state.tables.contacts![0] = { ...(state.tables.contacts![0] as object), phone_1: "+15555550123" };
    await expect(verifySlackCanaryFixture({ job, runId: RUN_ID, propertyId: PROPERTY_ID })).resolves.toBe(false);
  });

  it.each(["rep_sms_obligations", "rep_sms_delivery_ledger", "dialpad_call_intents"])("rejects a fixture with a provider safety row in %s", async (table) => {
    state.tables[table] = [{ id: "provider-row", org_id: ORG_ID, property_id: PROPERTY_ID }];
    state.providerSafe = false;
    await expect(verifySlackCanaryFixture({ job, runId: RUN_ID, propertyId: PROPERTY_ID })).resolves.toBe(false);
  });

  it("fails closed when the provider safety RPC is unavailable", async () => {
    state.rpcError = true;
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

  it("rejects a fixture without a recorded attempt", async () => {
    state.attemptFacts[0] = { latest_attempt_id: null, latest_attempt_outcome: null };
    await expect(verifySlackCanaryFixture({ job, runId: RUN_ID, propertyId: PROPERTY_ID })).resolves.toBe(false);
  });

  it("rejects an attempt that is not the historical reached outcome", async () => {
    state.attemptFacts[0] = { latest_attempt_id: "attempt", latest_attempt_outcome: "no_answer" };
    await expect(verifySlackCanaryFixture({ job, runId: RUN_ID, propertyId: PROPERTY_ID })).resolves.toBe(false);
  });
});
