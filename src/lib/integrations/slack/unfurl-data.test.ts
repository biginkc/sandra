import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/types";

import { loadPreviewData } from "./unfurl-data";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const PROPERTY = "33333333-3333-4333-8333-333333333333";
const OTHER_PROPERTY = "44444444-4444-4444-8444-444444444444";
const CONTACT = "55555555-5555-4555-8555-555555555555";
const OWNER = "66666666-6666-4666-8666-666666666666";

type QueryCall = {
  table: string;
  select: string | null;
  equals: Record<string, string>;
  is: Record<string, null>;
  ors: string[];
  orders: Array<{ column: string; ascending: boolean }>;
  limit: number | null;
};

type Fixture = {
  property?: Record<string, unknown> | null;
  contact?: Record<string, unknown> | null;
  messages?: Record<string, unknown>[];
  successfulMessage?: Record<string, unknown> | null;
  latestAttempt?: Record<string, unknown> | null;
  reachedCall?: Record<string, unknown> | null;
  user?: { email?: string | null; app_metadata?: Record<string, unknown> } | null;
};

function fakeClient(fixture: Fixture = {}) {
  const calls: QueryCall[] = [];
  const organization = { id: ORG, name: "Preview Org" };

  const resolve = (call: QueryCall) => {
    if (call.table === "organizations") return { data: organization, error: null };
    if (call.table === "properties") {
      const property = fixture.property === undefined ? {
        id: PROPERTY,
        org_id: ORG,
        address: "123 Main St",
        city: "Kansas City",
        state: "MO",
        homeowner_contact_id: CONTACT,
        assigned_user_id: OWNER,
        outreach_dispo: "not_interested",
      } : fixture.property;
      if (
        property &&
        call.is.deleted_at === null &&
        property.deleted_at !== undefined &&
        property.deleted_at !== null
      ) {
        return { data: null, error: null };
      }
      return { data: property, error: null };
    }
    if (call.table === "contacts") return { data: fixture.contact === undefined ? {
      id: CONTACT,
      org_id: ORG,
      first_name: "Jane",
      last_name: "Seller",
      entity_name: null,
    } : fixture.contact, error: null };
    if (call.table === "messages") {
      const successful = call.limit === 1 && call.ors.some((value) => value.includes("sent,delivered"));
      return {
        data: successful ? fixture.successfulMessage ?? null : fixture.messages ?? [],
        error: null,
      };
    }
    if (call.table === "acquisition_attempts") {
      const reached = "attempt_kind" in call.equals && "outcome" in call.equals;
      return { data: reached ? fixture.reachedCall ?? null : fixture.latestAttempt ?? null, error: null };
    }
    return { data: null, error: null };
  };

  const client = {
    from(table: string) {
      const call: QueryCall = { table, select: null, equals: {}, is: {}, ors: [], orders: [], limit: null };
      calls.push(call);
      const builder = {
        select(columns: string) { call.select = columns; return builder; },
        eq(column: string, value: string) { call.equals[column] = value; return builder; },
        is(column: string, value: null) { call.is[column] = value; return builder; },
        or(filters: string) { call.ors.push(filters); return builder; },
        order(column: string, options: { ascending: boolean }) { call.orders.push({ column, ascending: options.ascending }); return builder; },
        limit(count: number) { call.limit = count; return builder; },
        maybeSingle() { return Promise.resolve(resolve(call)); },
        then(onFulfilled: (value: ReturnType<typeof resolve>) => unknown, onRejected?: (reason: unknown) => unknown) {
          return Promise.resolve(resolve(call)).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: fixture.user === undefined ? {
          email: "owner@example.test",
          app_metadata: { display_name: "Owner Name" },
        } : fixture.user }, error: null }),
      },
    },
  };

  return { client: client as unknown as SupabaseClient<Database>, calls };
}

function callsFor(calls: QueryCall[], table: string) {
  return calls.filter((call) => call.table === table);
}

describe("loadPreviewData", () => {
  it("uses the authoritative org/property/message/attempt contract and every tenant filter", async () => {
    const { client, calls } = fakeClient({
      messages: [
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", created_at: "2026-10-03T12:01:00.000Z", body: "Them", direction: "inbound", status: "received", metadata: null },
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", created_at: "2026-10-03T12:00:00.000Z", body: "Us", direction: "outbound", status: "failed", metadata: { mediaUrls: ["x"] } },
      ],
      successfulMessage: { id: "99999999-9999-4999-8999-999999999999", created_at: "2026-10-03T11:59:00.000Z" },
      latestAttempt: { id: "77777777-7777-4777-8777-777777777777", occurred_at: "2026-10-03T11:58:00.000Z", outcome: "no_answer" },
      reachedCall: null,
    });

    const result = await loadPreviewData({ client, orgId: ORG, propertyId: PROPERTY });

    expect(result).toMatchObject({
      propertyId: PROPERTY,
      leadName: "Jane Seller",
      address: "123 Main St, Kansas City, MO",
      ownerName: "Owner Name",
      ownerAssigned: true,
      latestAttempt: { outcome: "no_answer" },
      messagesDisposition: "not_interested",
      lastContactAt: "2026-10-03T11:59:00.000Z",
      timezone: "America/Chicago",
    });
    expect(result?.messages.map((message) => message.id)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);

    expect(callsFor(calls, "properties")[0]).toMatchObject({
      select: "id, org_id, address, city, state, homeowner_contact_id, assigned_user_id, outreach_dispo",
      equals: { org_id: ORG, id: PROPERTY },
      is: { deleted_at: null },
    });
    expect(callsFor(calls, "contacts")[0]).toMatchObject({
      select: "id, org_id, first_name, last_name, entity_name",
      equals: { org_id: ORG, id: CONTACT },
    });

    const messageCalls = callsFor(calls, "messages");
    expect(messageCalls).toHaveLength(2);
    expect(messageCalls[0]).toMatchObject({
      select: "id, created_at, body, direction, status, metadata",
      equals: { org_id: ORG, channel: "sms" },
      ors: [
        "direction.eq.inbound,and(direction.eq.outbound,status.in.(sent,delivered,failed,bounced))",
        `property_id.eq.${PROPERTY},and(property_id.is.null,contact_id.eq.${CONTACT})`,
      ],
      orders: [
        { column: "created_at", ascending: false },
        { column: "id", ascending: false },
      ],
      limit: 3,
    });
    expect(messageCalls[1]).toMatchObject({
      select: "id, created_at",
      equals: { org_id: ORG, channel: "sms" },
      ors: [
        "direction.eq.inbound,and(direction.eq.outbound,status.in.(sent,delivered))",
        `property_id.eq.${PROPERTY},and(property_id.is.null,contact_id.eq.${CONTACT})`,
      ],
      limit: 1,
    });

    const attemptCalls = callsFor(calls, "acquisition_attempts");
    for (const call of attemptCalls) {
      expect(call.equals.org_id).toBe(ORG);
      expect(call.equals.property_id).toBe(PROPERTY);
      expect(call.orders).toEqual([
        { column: "occurred_at", ascending: false },
        { column: "id", ascending: false },
      ]);
    }
    expect(attemptCalls.find((call) => call.equals.attempt_kind === undefined)).toMatchObject({
      select: "id, occurred_at, outcome",
      equals: { org_id: ORG, property_id: PROPERTY },
    });
    expect(attemptCalls.find((call) => call.equals.attempt_kind === "call")).toMatchObject({
      select: "id, occurred_at",
      equals: {
        org_id: ORG,
        property_id: PROPERTY,
        attempt_kind: "call",
        outcome: "reached",
      },
    });
  });

  it("keeps shared-contact history isolated to contact-only rows and explicit property rows", async () => {
    const { client, calls } = fakeClient();
    await loadPreviewData({ client, orgId: ORG, propertyId: PROPERTY });

    for (const call of callsFor(calls, "messages")) {
      expect(call.ors).toContain(
        `property_id.eq.${PROPERTY},and(property_id.is.null,contact_id.eq.${CONTACT})`,
      );
      expect(call.ors.join(" ")).not.toContain(`contact_id.eq.${CONTACT},property_id`);
      expect(call.ors.join(" ")).not.toContain(OTHER_PROPERTY);
    }
  });

  it("includes failed outbound texts in the strip but excludes them from last contact", async () => {
    const { client } = fakeClient({
      messages: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        created_at: "2026-10-03T12:00:00.000Z",
        body: "Not delivered",
        direction: "outbound",
        status: "bounced",
        metadata: null,
      }],
      successfulMessage: null,
      latestAttempt: null,
      reachedCall: null,
    });

    const result = await loadPreviewData({ client, orgId: ORG, propertyId: PROPERTY });

    expect(result?.messages[0]).toMatchObject({ direction: "outbound", deliveryStatus: "bounced" });
    expect(result?.lastContactAt).toBeNull();
  });

  it("sorts timestamp ties by id and reverses the newest-three query to oldest-first", async () => {
    const { client } = fakeClient({
      messages: [
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", created_at: "2026-10-03T12:00:00.000Z", body: "newer tie", direction: "inbound", status: "received", metadata: null },
        { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", created_at: "2026-10-03T12:00:00.000Z", body: "highest id", direction: "inbound", status: "received", metadata: null },
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", created_at: "2026-10-03T11:00:00.000Z", body: "oldest", direction: "outbound", status: "sent", metadata: null },
      ],
      successfulMessage: null,
      latestAttempt: null,
      reachedCall: null,
    });

    const result = await loadPreviewData({ client, orgId: ORG, propertyId: PROPERTY });

    expect(result?.messages.map((message) => message.body)).toEqual([
      "oldest",
      "newer tie",
      "highest id",
    ]);
  });

  it("returns truthful nulls when contact, assignment, attempts, and texts are absent", async () => {
    const { client, calls } = fakeClient({
      property: {
        id: PROPERTY,
        org_id: ORG,
        address: null,
        city: null,
        state: null,
        homeowner_contact_id: null,
        assigned_user_id: null,
        outreach_dispo: null,
      },
      latestAttempt: null,
      successfulMessage: null,
      reachedCall: null,
      messages: [],
    });

    const result = await loadPreviewData({ client, orgId: ORG, propertyId: PROPERTY });

    expect(result).toMatchObject({
      leadName: null,
      address: null,
      ownerName: null,
      ownerAssigned: false,
      latestAttempt: null,
      messagesDisposition: null,
      lastContactAt: null,
      messages: [],
    });
    expect(callsFor(calls, "memberships")).toHaveLength(0);
    for (const call of callsFor(calls, "messages")) {
      expect(call.ors).toContain(`property_id.eq.${PROPERTY}`);
      expect(call.ors.join(" ")).not.toContain("contact_id.eq.");
    }
  });

  it("returns null and skips contact/message reads for malformed homeowner metadata", async () => {
    const { client, calls } = fakeClient({
      property: {
        id: PROPERTY,
        org_id: ORG,
        address: "123 Main St",
        city: "Kansas City",
        state: "MO",
        homeowner_contact_id: "not-a-uuid",
        assigned_user_id: OWNER,
        outreach_dispo: null,
      },
    });

    await expect(loadPreviewData({ client, orgId: ORG, propertyId: PROPERTY })).resolves.toBeNull();
    expect(callsFor(calls, "contacts")).toHaveLength(0);
    expect(callsFor(calls, "messages")).toHaveLength(0);
  });

  it("does not return a soft-deleted property", async () => {
    const { client, calls } = fakeClient({
      property: {
        id: PROPERTY,
        org_id: ORG,
        address: "Deleted Main St",
        city: "Kansas City",
        state: "MO",
        homeowner_contact_id: CONTACT,
        assigned_user_id: OWNER,
        outreach_dispo: null,
        deleted_at: "2026-10-03T12:00:00.000Z",
      },
    });

    await expect(loadPreviewData({ client, orgId: ORG, propertyId: PROPERTY })).resolves.toBeNull();
    expect(callsFor(calls, "properties")[0]?.is).toEqual({ deleted_at: null });
    expect(callsFor(calls, "messages")).toHaveLength(0);
  });

  it.each([
    [
      "call wins",
      { created_at: "2026-10-03T11:00:00.000Z" },
      { occurred_at: "2026-10-03T12:00:00.000Z" },
      "2026-10-03T12:00:00.000Z",
    ],
    [
      "text wins",
      { created_at: "2026-10-03T12:00:00.000Z" },
      { occurred_at: "2026-10-03T11:00:00.000Z" },
      "2026-10-03T12:00:00.000Z",
    ],
    [
      "a tie prefers the message representation",
      { created_at: "2026-10-03T12:00:00.000Z" },
      { occurred_at: "2026-10-03T07:00:00-05:00" },
      "2026-10-03T12:00:00.000Z",
    ],
  ])("uses the latest successful contact time when %s", async (_case, successfulMessage, reachedCall, expected) => {
    const { client } = fakeClient({ successfulMessage, reachedCall });

    const result = await loadPreviewData({ client, orgId: ORG, propertyId: PROPERTY });

    expect(result?.lastContactAt).toBe(expected);
  });

  it("fails closed when the property row is not in the requested organization", async () => {
    const { client } = fakeClient({
      property: {
        id: PROPERTY,
        org_id: OTHER_ORG,
        address: "Foreign address",
        city: "Foreign city",
        state: "MO",
        homeowner_contact_id: CONTACT,
        assigned_user_id: OWNER,
        outreach_dispo: "dnc",
      },
    });

    await expect(loadPreviewData({ client, orgId: ORG, propertyId: PROPERTY })).resolves.toBeNull();
  });

  it("preserves a former assigned member label without a membership lookup", async () => {
    const { client, calls } = fakeClient({
      user: { email: "Former.Owner@Example.test", app_metadata: { display_name: "Former Owner" } },
    });

    await expect(loadPreviewData({ client, orgId: ORG, propertyId: PROPERTY })).resolves.toMatchObject({
      ownerName: "Former Owner",
      ownerAssigned: true,
    });
    expect(callsFor(calls, "memberships")).toHaveLength(0);
  });

  it("uses the lowercased verified email when an assigned identity has no display name", async () => {
    const { client } = fakeClient({ user: { email: "OWNER@EXAMPLE.TEST", app_metadata: {} } });

    await expect(loadPreviewData({ client, orgId: ORG, propertyId: PROPERTY })).resolves.toMatchObject({
      ownerName: "owner@example.test",
      ownerAssigned: true,
    });
  });

  it("does not fabricate a name for an assigned identity without a verified label", async () => {
    const { client } = fakeClient({ user: { email: null, app_metadata: {} } });

    await expect(loadPreviewData({ client, orgId: ORG, propertyId: PROPERTY })).resolves.toMatchObject({
      ownerName: null,
      ownerAssigned: true,
    });
  });
});
