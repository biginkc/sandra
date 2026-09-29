import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/types";
import { cleanupAllCanaries, cleanupCanary } from "../../../scripts/sequence-canary-cleanup";
import { preflightFixture } from "../../../scripts/sequence-canary-fixture";

const owner = "11111111-1111-4111-8111-111111111111";
const property = "22222222-2222-4222-8222-222222222222";
const contact = "33333333-3333-4333-8333-333333333333";
function fakeClient(failingTable?: string, wrongProperty = false) {
  const deletes: { table: string; column?: string; values?: string[] }[] = [];
  const rows: Record<string, unknown[]> = {
    sequences: [{ id: "s", name: "SMOKE TEST — safe to delete 2026-09-28", created_by: owner }],
    sequence_enrollments: [{ id: "e", property_id: wrongProperty ? "other" : property }],
    sequence_step_runs: [{ message_id: "m1" }, { message_id: "m1" }, { message_id: null }],
  };
  return {
    deletes,
    client: { from(table: string) {
      let deleting = false;
      const query = {
        select: () => query,
        eq: () => query,
        in: (column: string, values: string[]) => {
          if (deleting) deletes.push({ table, column, values });
          return query;
        },
        maybeSingle: async () => ({ data: rows[table]?.[0] ?? null, error: null }),
        delete: () => { deleting = true; if (table !== "messages") deletes.push({ table }); return query; },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(resolve(deleting
            ? { error: table === failingTable ? { message: "forced delete error" } : null }
            : { data: rows[table] ?? [], error: null }));
        },
      };
      return query;
    } } as unknown as SupabaseClient<Database>,
  };
}

it("deletes only run-linked message IDs, enrollment, steps, and sequence", async () => {
  const { client, deletes } = fakeClient();
  await cleanupCanary(client, "s", owner, property);
  expect(deletes).toEqual([
    { table: "messages", column: "id", values: ["m1"] },
    { table: "sequence_enrollments" }, { table: "sequence_steps" }, { table: "sequences" },
  ]);
});

it("refuses a non-fixture enrollment before any delete", async () => {
  const { client, deletes } = fakeClient(undefined, true);
  await expect(cleanupCanary(client, "s", owner, property)).rejects.toThrow("non-fixture property");
  expect(deletes).toEqual([]);
});

it("cleanup-only validates every discovered enrollment before deleting any sequence", async () => {
  const deletes: string[] = [];
  let sequenceId = "";
  const client = { from(table: string) {
    let deleting = false;
    const query = {
      select: () => query,
      eq: (column: string, value: string) => { if (column === "sequence_id") sequenceId = value; return query; },
      like: () => query,
      limit: () => query,
      delete: () => { deleting = true; deletes.push(table); return query; },
      then(resolve: (value: unknown) => unknown) {
        const data = table === "sequences" ? [{ id: "safe" }, { id: "unsafe" }]
          : [{ property_id: sequenceId === "safe" ? property : "other" }];
        return Promise.resolve(resolve({ data: deleting ? null : data, error: null }));
      },
    };
    return query;
  } } as unknown as SupabaseClient<Database>;
  await expect(cleanupAllCanaries(client, owner, property)).rejects.toThrow("non-fixture property");
  expect(deletes).toEqual([]);
});

it("turns a failed delete into a red canary", async () => {
  const { client, deletes } = fakeClient("sequence_enrollments");
  await expect(cleanupCanary(client, "s", owner, property)).rejects.toThrow("Canary cleanup enrollments: forced delete error");
  expect(deletes.map((row) => row.table)).not.toContain("sequences");
});

it("refuses a sequence without the canary owner", async () => {
  const { client, deletes } = fakeClient();
  await expect(cleanupCanary(client, "s", property, property)).rejects.toThrow("Refusing to clean unowned");
  expect(deletes).toEqual([]);
});

it("fixture preflight failure makes zero inserts", async () => {
  const inserts: string[] = [];
  const client = {
    auth: { admin: { getUserById: async () => ({ data: { user: { id: owner } }, error: null }) } },
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: () => { inserts.push(table); return query; },
      };
      return query;
    },
  } as unknown as SupabaseClient<Database>;
  await expect(preflightFixture(client, { userId: owner, propertyId: property, contactId: contact }))
    .rejects.toThrow("Canary property missing");
  expect(inserts).toEqual([]);
});
