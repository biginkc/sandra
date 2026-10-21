import { beforeEach, describe, expect, it, vi } from "vitest";

const { pauseContactEnrollments } = vi.hoisted(() => ({ pauseContactEnrollments: vi.fn() }));
vi.mock("@/lib/sequences/enrollment", () => ({ pauseContactEnrollments }));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { pauseEnrollmentsForInboundCall } from "./inbound-call-pause";

type Filters = Record<string, unknown>;

function fakeClient(call: { org_id: string; from_e164: string } | null, contacts: Array<{ id: string; org_id: string; phone_1?: string; phone_2?: string; phone_3?: string }>) {
  const contactQueries: Filters[] = [];
  const client = {
    from(table: string) {
      const filters: Filters = {};
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        async maybeSingle() {
          return { data: table === "norma_inbound_calls" && filters.id === "call-row" ? call : null, error: null };
        },
        then(resolve: (v: unknown) => void) {
          contactQueries.push({ ...filters });
          const rows = contacts.filter((c) =>
            Object.entries(filters).every(([k, v]) => (c as Record<string, unknown>)[k] === v),
          );
          resolve({ data: rows.map((c) => ({ id: c.id })), error: null });
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, contactQueries };
}

beforeEach(() => {
  pauseContactEnrollments.mockReset();
  pauseContactEnrollments.mockResolvedValue({ paused: 1 });
});

describe("pauseEnrollmentsForInboundCall", () => {
  it("pauses every matched contact in the call's org with inbound_call", async () => {
    const { client, contactQueries } = fakeClient({ org_id: "org-1", from_e164: "+18165550101" }, [
      { id: "c-1", org_id: "org-1", phone_1: "+18165550101" },
      { id: "c-2", org_id: "org-1", phone_3: "+18165550101" },
      { id: "c-other-org", org_id: "org-2", phone_1: "+18165550101" },
      { id: "c-other-phone", org_id: "org-1", phone_1: "+18165550999" },
    ]);
    const result = await pauseEnrollmentsForInboundCall(client, "call-row");
    expect(result).toEqual({ matchedContactIds: ["c-1", "c-2"], paused: 2 });
    expect(pauseContactEnrollments.mock.calls.map((c) => c[1])).toEqual([
      { contactId: "c-1", reason: "inbound_call" },
      { contactId: "c-2", reason: "inbound_call" },
    ]);
    expect(contactQueries.every((q) => q.org_id === "org-1")).toBe(true);
  });

  it("pauses nothing when no contact matches the caller", async () => {
    const { client } = fakeClient({ org_id: "org-1", from_e164: "+18165550101" }, [
      { id: "c-1", org_id: "org-1", phone_1: "+18165550999" },
    ]);
    expect(await pauseEnrollmentsForInboundCall(client, "call-row")).toEqual({ matchedContactIds: [], paused: 0 });
    expect(pauseContactEnrollments).not.toHaveBeenCalled();
  });

  it("pauses nothing when the call record is missing", async () => {
    const { client } = fakeClient(null, []);
    expect(await pauseEnrollmentsForInboundCall(client, "call-row")).toEqual({ matchedContactIds: [], paused: 0 });
    expect(pauseContactEnrollments).not.toHaveBeenCalled();
  });
});
