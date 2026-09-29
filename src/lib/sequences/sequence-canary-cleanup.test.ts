import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/types";
import { cleanupCanary } from "../../../scripts/sequence-canary-cleanup";

const owner = "11111111-1111-4111-8111-111111111111";
function fakeClient(failingTable?: string) {
  const deletes: string[] = [];
  const rows: Record<string, unknown[]> = {
    sequences: [{ id: "s", org_id: "org", name: "SMOKE TEST — safe to delete 2026-09-28", created_by: owner }],
    sequence_enrollments: [{ id: "e", property_id: "p", contact_id: "c" }],
    properties: [{ id: "p", org_id: "org", address: "E2E PROD SMOKE 2026-09-28", homeowner_contact_id: "c" }],
    contacts: [{ id: "c", org_id: "org", first_name: "Smoke", last_name: "Prod 2026-09-28", phone_1: "+10000000000" }],
  };
  return {
    deletes,
    client: { from(table: string) {
      let deleting = false;
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        maybeSingle: async () => ({ data: rows[table]?.[0] ?? null, error: null }),
        delete: () => { deleting = true; deletes.push(table); return query; },
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

it("cascades step runs from enrollment and checks each delete", async () => {
  const { client, deletes } = fakeClient();
  await cleanupCanary(client, "s", owner);
  expect(deletes).toEqual(["messages", "consent_events", "sequence_enrollments", "sequence_steps", "properties", "contacts", "sequences"]);
  expect(deletes).not.toContain("sequence_step_runs");
});

it("turns a failed delete into a red canary", async () => {
  const { client, deletes } = fakeClient("sequence_enrollments");
  await expect(cleanupCanary(client, "s", owner)).rejects.toThrow("Canary cleanup enrollments: forced delete error");
  expect(deletes).not.toContain("sequences");
});

it("refuses a sequence without the canary owner", async () => {
  const { client, deletes } = fakeClient();
  await expect(cleanupCanary(client, "s", "22222222-2222-4222-8222-222222222222")).rejects.toThrow("Refusing to clean unowned");
  expect(deletes).toEqual([]);
});
