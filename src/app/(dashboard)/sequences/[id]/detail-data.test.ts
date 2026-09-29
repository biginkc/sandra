import { expect, it, vi } from "vitest";

const { createClient, getSequenceWithSteps } = vi.hoisted(() => ({
  createClient: vi.fn(), getSequenceWithSteps: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("../actions", () => ({ getSequenceWithSteps }));

import { getDripDetail } from "./detail-data";

it("opens each property's own latest SMS conversation even when a shared owner's other property is newer", async () => {
  getSequenceWithSteps.mockResolvedValue({ ok: true, data: { id: "sequence", steps: [] } });
  const calls: Array<{ table: string; select: string; ids?: string[]; filters: Array<[string, unknown]>; order?: unknown; limit?: unknown }> = [];
  const rows: Record<string, unknown> = {
    sequences: { data: { org_id: "org" }, error: null },
    sequence_enrollments: { data: [
      { id: "enrollment-a", property_id: "property-a", status: "active", pause_reason: null, current_step_index: 0, next_run_at: null, enrolled_at: "2026-09-28T00:00:00Z" },
      { id: "enrollment-b", property_id: "property-b", status: "active", pause_reason: null, current_step_index: 0, next_run_at: null, enrolled_at: "2026-09-29T00:00:00Z" },
      { id: "enrollment-c", property_id: "property-c", status: "active", pause_reason: null, current_step_index: 0, next_run_at: null, enrolled_at: "2026-09-29T00:00:00Z" },
    ], count: 3, error: null },
    contacts: { data: [{ id: "shared-owner", first_name: "Shared", last_name: "Owner" }], error: null },
  };
  const properties = [
    { id: "property-a", address: "A Street", homeowner_contact_id: "shared-owner", thread_messages: [{ conversation_id: "conversation-a", created_at: "2026-09-28T12:00:00Z" }] },
    { id: "property-b", address: "B Street", homeowner_contact_id: "shared-owner", thread_messages: [{ conversation_id: "conversation-b", created_at: "2026-09-29T12:00:00Z" }] },
    { id: "property-c", address: "C Street", homeowner_contact_id: null, thread_messages: [] },
  ];
  const from = vi.fn((table: string) => ({
    select(select: string) {
      const call: { table: string; select: string; ids?: string[]; filters: Array<[string, unknown]>; order?: unknown; limit?: unknown } = { table, select, filters: [] };
      calls.push(call);
      const query = {
        eq: (column: string, value: unknown) => { call.filters.push([column, value]); return query; },
        in: (_column: string, ids: string[]) => { call.ids = ids; return query; },
        not: (column: string, operator: string, value: unknown) => { call.filters.push([column, `${operator}:${value}`]); return query; },
        order: (_column: string, options: unknown) => { call.order = options; return query; },
        limit: (count: number, options: unknown) => { call.limit = [count, options]; return query; },
        single: async () => rows[table],
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(table === "properties"
          ? { data: properties, error: null } : rows[table])),
      };
      return query;
    },
  }));
  createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: "user" } } }) },
    rpc: async () => ({ data: [], error: null }), from });

  const result = await getDripDetail("sequence");
  expect(result.ok).toBe(true);
  if (!result.ok || !result.data) return;
  expect(result.data.people.map((person) => [person.propertyId, person.threadId])).toEqual([
    ["property-a", "conversation-a"], ["property-b", "conversation-b"], ["property-c", null],
  ]);
  expect(calls.filter((call) => call.table === "properties" && call.select.includes("thread_messages"))).toEqual([
    expect.objectContaining({
      ids: ["property-a", "property-b", "property-c"],
      filters: expect.arrayContaining([["thread_messages.channel", "sms"], ["thread_messages.conversation_id", "is:null"]]),
      order: { referencedTable: "thread_messages", ascending: false },
      limit: [1, { referencedTable: "thread_messages" }],
    }),
  ]);
});
