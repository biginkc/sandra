import { beforeEach, describe, expect, it, vi } from "vitest";

const { pauseContactEnrollments } = vi.hoisted(() => ({ pauseContactEnrollments: vi.fn() }));
vi.mock("@/lib/sequences/enrollment", () => ({ pauseContactEnrollments }));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { pauseEnrollmentsForInboundCall } from "./inbound-call-pause";

type Contact = { id: string; org_id: string; phone_1?: string | null; phone_2?: string | null; phone_3?: string | null };
type Enrollment = { id: string; property_id: string; status: string; pause_reason: string | null };

function fakeClient(
  call: { org_id: string; from_e164: string } | null,
  contacts: Contact[],
  world: { properties?: Array<{ id: string; homeowner_contact_id: string }>; enrollments?: Enrollment[] } = {},
) {
  const contactQueries: Array<Record<string, unknown>> = [];
  const properties = world.properties ?? [];
  const enrollments = world.enrollments ?? [];
  const client = {
    from(table: string) {
      const eq: Record<string, unknown> = {};
      const inF: Record<string, unknown[]> = {};
      let orFilter: string | null = null;
      let update: Record<string, unknown> | null = null;
      const result = () => {
        if (table === "contacts") {
          contactQueries.push({ ...eq, or: orFilter });
          const last4 = /%(\d{4})%/.exec(orFilter ?? "")?.[1] ?? "";
          const rows = contacts.filter(
            (c) => c.org_id === eq.org_id && [c.phone_1, c.phone_2, c.phone_3].some((p) => (p ?? "").includes(last4)),
          );
          return { data: rows, error: null };
        }
        if (table === "properties") {
          return { data: properties.filter((p) => p.homeowner_contact_id === eq.homeowner_contact_id), error: null };
        }
        if (table === "sequence_enrollments" && update) {
          const hit = enrollments.filter(
            (e) =>
              inF.property_id.includes(e.property_id) &&
              e.status === eq.status &&
              inF.pause_reason.includes(e.pause_reason),
          );
          for (const e of hit) Object.assign(e, update);
          return { data: hit.map((e) => ({ id: e.id })), error: null };
        }
        return { data: null, error: null };
      };
      const builder = {
        select: () => builder,
        update(patch: Record<string, unknown>) {
          update = patch;
          return builder;
        },
        eq(column: string, value: unknown) {
          eq[column] = value;
          return builder;
        },
        in(column: string, values: unknown[]) {
          inF[column] = values;
          return builder;
        },
        or(filter: string) {
          orFilter = filter;
          return builder;
        },
        async maybeSingle() {
          return { data: table === "norma_inbound_calls" && eq.id === "call-row" ? call : null, error: null };
        },
        then(resolve: (v: unknown) => void) {
          resolve(result());
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
      { id: "c-same-last4", org_id: "org-1", phone_1: "+19135550101" },
    ]);
    const result = await pauseEnrollmentsForInboundCall(client, "call-row");
    expect(result).toEqual({ matchedContactIds: ["c-1", "c-2"], paused: 2 });
    expect(pauseContactEnrollments.mock.calls.map((c) => c[1])).toEqual([
      { contactId: "c-1", reason: "inbound_call" },
      { contactId: "c-2", reason: "inbound_call" },
    ]);
    expect(contactQueries.every((q) => q.org_id === "org-1")).toBe(true);
  });

  it.each(["8165550101", "(816) 555-0101", "816.555.0101", "1-816-555-0101"])(
    "matches a %s slot against a +18165550101 caller",
    async (slot) => {
      const { client } = fakeClient({ org_id: "org-1", from_e164: "+18165550101" }, [
        { id: "c-1", org_id: "org-1", phone_2: slot },
      ]);
      const result = await pauseEnrollmentsForInboundCall(client, "call-row");
      expect(result.matchedContactIds).toEqual(["c-1"]);
      expect(pauseContactEnrollments).toHaveBeenCalledWith(client, { contactId: "c-1", reason: "inbound_call" });
    },
  );

  it("pauses through pauseContactEnrollments only (its single UPDATE also takes over reconciliation holds)", async () => {
    pauseContactEnrollments.mockResolvedValue({ paused: 1 });
    const enrollments: Enrollment[] = [
      { id: "e-recon", property_id: "p-1", status: "paused", pause_reason: "reconciliation_required" },
    ];
    const { client } = fakeClient(
      { org_id: "org-1", from_e164: "+18165550101" },
      [{ id: "c-1", org_id: "org-1", phone_1: "8165550101" }],
      { properties: [{ id: "p-1", homeowner_contact_id: "c-1" }], enrollments },
    );
    const result = await pauseEnrollmentsForInboundCall(client, "call-row");
    expect(result.paused).toBe(1);
    expect(pauseContactEnrollments).toHaveBeenCalledTimes(1);
    expect(pauseContactEnrollments).toHaveBeenCalledWith(client, { contactId: "c-1", reason: "inbound_call" });
    // No second, separate takeover write from this module.
    expect(enrollments[0].pause_reason).toBe("reconciliation_required");
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
