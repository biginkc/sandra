import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordLeadEvents } = vi.hoisted(() => ({ recordLeadEvents: vi.fn() }));
vi.mock("@/lib/events", () => ({ recordLeadEvents, LEAD_EVENT_TYPES: { SEQUENCE_PAUSED: "sequence_paused" } }));

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
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      const contactIds = (args.p_contact_ids as string[]) ?? [];
      const propertyIds = properties.filter((p) => contactIds.includes(p.homeowner_contact_id)).map((p) => p.id);
      const hit = enrollments.filter(
        (e) => propertyIds.includes(e.property_id) && (e.status === "active" || (e.status === "paused" &&
          ["reconciliation_required", "call_in_progress", "norma_call"].includes(e.pause_reason ?? ""))),
      );
      for (const e of hit) Object.assign(e, { status: "paused", pause_reason: "inbound_call" });
      return { data: hit.map((e) => ({ id: e.id, property_id: e.property_id, sequence_id: "seq-1" })), error: null };
    },
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
  return { client: client as unknown as SupabaseClient<Database>, contactQueries, rpcCalls };
}

beforeEach(() => {
  recordLeadEvents.mockReset();
});

const props = [{ id: "p-1", homeowner_contact_id: "c-1" }, { id: "p-2", homeowner_contact_id: "c-2" }];

describe("pauseEnrollmentsForInboundCall", () => {
  it("pauses every matched contact in the call's org in one RPC call", async () => {
    const enrollments: Enrollment[] = [
      { id: "e-1", property_id: "p-1", status: "active", pause_reason: null },
      { id: "e-2", property_id: "p-2", status: "active", pause_reason: null },
    ];
    const { client, contactQueries, rpcCalls } = fakeClient({ org_id: "org-1", from_e164: "+18165550101" }, [
      { id: "c-1", org_id: "org-1", phone_1: "+18165550101" },
      { id: "c-2", org_id: "org-1", phone_3: "+18165550101" },
      { id: "c-other-org", org_id: "org-2", phone_1: "+18165550101" },
      { id: "c-other-phone", org_id: "org-1", phone_1: "+18165550999" },
      { id: "c-same-last4", org_id: "org-1", phone_1: "+19135550101" },
    ], { properties: props, enrollments });
    const result = await pauseEnrollmentsForInboundCall(client, "call-row");
    expect(result).toEqual({ matchedContactIds: ["c-1", "c-2"], paused: 2 });
    expect(rpcCalls).toEqual([{ fn: "pause_enrollments_for_inbound_call", args: { p_contact_ids: ["c-1", "c-2"] } }]);
    expect(contactQueries.every((q) => q.org_id === "org-1")).toBe(true);
    expect(recordLeadEvents).toHaveBeenCalledTimes(1);
  });

  it.each(["8165550101", "(816) 555-0101", "816.555.0101", "1-816-555-0101"])(
    "matches a %s slot against a +18165550101 caller",
    async (slot) => {
      const { client, rpcCalls } = fakeClient({ org_id: "org-1", from_e164: "+18165550101" }, [
        { id: "c-1", org_id: "org-1", phone_2: slot },
      ]);
      const result = await pauseEnrollmentsForInboundCall(client, "call-row");
      expect(result.matchedContactIds).toEqual(["c-1"]);
      expect(rpcCalls[0]).toEqual({ fn: "pause_enrollments_for_inbound_call", args: { p_contact_ids: ["c-1"] } });
    },
  );

  it("active, reconciliation holds and temporary call pauses all become inbound_call; real stops are left", async () => {
    const enrollments: Enrollment[] = [
      { id: "e-a", property_id: "p-1", status: "active", pause_reason: null },
      { id: "e-r", property_id: "p-1", status: "paused", pause_reason: "reconciliation_required" },
      { id: "e-c", property_id: "p-1", status: "paused", pause_reason: "call_in_progress" },
      { id: "e-n", property_id: "p-1", status: "paused", pause_reason: "norma_call" },
      { id: "e-i", property_id: "p-1", status: "paused", pause_reason: "inbound_reply" },
    ];
    const { client } = fakeClient({ org_id: "org-1", from_e164: "+18165550101" },
      [{ id: "c-1", org_id: "org-1", phone_1: "8165550101" }], { properties: props, enrollments });
    expect((await pauseEnrollmentsForInboundCall(client, "call-row")).paused).toBe(4);
    expect(enrollments.map((e) => e.pause_reason)).toEqual(["inbound_call", "inbound_call", "inbound_call", "inbound_call", "inbound_reply"]);
  });

  it("pauses nothing when no contact matches the caller", async () => {
    const { client, rpcCalls } = fakeClient({ org_id: "org-1", from_e164: "+18165550101" }, [
      { id: "c-1", org_id: "org-1", phone_1: "+18165550999" },
    ]);
    expect(await pauseEnrollmentsForInboundCall(client, "call-row")).toEqual({ matchedContactIds: [], paused: 0 });
    expect(rpcCalls).toEqual([]);
  });

  it("pauses nothing when the call record is missing", async () => {
    const { client, rpcCalls } = fakeClient(null, []);
    expect(await pauseEnrollmentsForInboundCall(client, "call-row")).toEqual({ matchedContactIds: [], paused: 0 });
    expect(rpcCalls).toEqual([]);
  });
});
