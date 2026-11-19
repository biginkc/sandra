import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  live: [] as Array<{ id?: string; property_id: string; status?: string; pause_reason?: string | null }>,
  marker: { last_person_takeover_at: null as string | null },
  newerInbound: [] as Array<{ id: string }>,
  pause: vi.fn(async (..._a: unknown[]) => ({ paused: 1 })),
  updates: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, unknown]>,
  fail: false,
  onUpdate: null as null | ((v: Record<string, unknown>) => void),
  rpcCalls: [] as Array<[string, unknown]>,
  report: vi.fn(),
  rpcOk: false,
  rpcError: "Could not find the function public.routing_v2_mark_person_takeover",
  markFail: false,
  tableUpdates: [] as Array<[string, Record<string, unknown>]>,
}));

vi.mock("@/lib/errors/report", () => ({ reportError: mocks.report }));
vi.mock("./enrollment", () => ({ pausePropertyEnrollments: mocks.pause }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: unknown) => {
      mocks.rpcCalls.push([fn, args]);
      return mocks.rpcOk && !mocks.fail ? { data: true, error: null } : { data: null, error: { message: mocks.rpcError } };
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.update = (v: Record<string, unknown>) => {
        mocks.updates.push(v);
        mocks.tableUpdates.push([table, v]);
        b.mark = "last_person_takeover_at" in v;
        mocks.onUpdate?.(v);
        return b;
      };
      b.in = () => b;
      b.gt = () => b;
      b.limit = () => b;
      b.eq = (c: string, v: unknown) => {
        mocks.filters.push([c, v]);
        return b;
      };
      b.maybeSingle = async () => ({ data: mocks.marker, error: null });
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(mocks.fail || (b.mark && mocks.markFail) ? { data: null, error: { message: "db down" } } : { data: table === "sequence_enrollments" ? mocks.live : table === "messages" ? mocks.newerInbound : null, error: null });
      return b;
    },
  }),
}));

import { pauseHotBookAppointmentOnTakeover } from "./hot-lead-takeover";

const actor = { actorType: "user", actorId: "u1" } as const;

beforeEach(() => {
  mocks.pause.mockClear();
  mocks.updates = [];
  mocks.filters = [];
  mocks.fail = false;
  mocks.onUpdate = null;
  mocks.live = [{ property_id: "p1" }];
  mocks.marker = { last_person_takeover_at: null };
  mocks.newerInbound = [];
  mocks.rpcCalls = [];
  mocks.rpcOk = false;
  mocks.rpcError = "Could not find the function public.routing_v2_mark_person_takeover";
  mocks.report.mockClear();
  mocks.markFail = false;
  mocks.tableUpdates = [];
});

describe("pauseHotBookAppointmentOnTakeover", () => {
  it("stamps the takeover on the DB clock through routing_v2_mark_person_takeover (no app-clock stamp)", async () => {
    mocks.rpcOk = true;
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).toEqual({ paused: 1 });
    expect(mocks.rpcCalls).toEqual([["routing_v2_mark_person_takeover", { p_property_id: "p1" }]]);
    expect(mocks.updates.some((u) => "last_person_takeover_at" in u)).toBe(false);
  });

  it("one routing lock per call: a multi-property takeover stamps each property separately (review N-6)", async () => {
    mocks.rpcOk = true;
    mocks.live = [{ property_id: "p1" }, { property_id: "p2" }];
    await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1", "p2"], actor });
    expect(mocks.rpcCalls).toEqual([
      ["routing_v2_mark_person_takeover", { p_property_id: "p1" }],
      ["routing_v2_mark_person_takeover", { p_property_id: "p2" }],
    ]);
  });

  it("any error other than a missing function is retried once, reported, then the DB's own time is written ('now', never the app clock) (Astra P1)", async () => {
    mocks.rpcError = "canceling statement due to lock timeout";
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).toEqual({ paused: 1 });
    expect(mocks.rpcCalls).toHaveLength(2);
    expect(mocks.tableUpdates).toContainEqual(["properties", { last_person_takeover_at: "now" }]);
    expect(mocks.report).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { surface: "hot_lead_takeover_stamp" } }));
  });

  it("a missing function also falls back to the DB's own time", async () => {
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).toEqual({ paused: 1 });
    expect(mocks.tableUpdates).toContainEqual(["properties", { last_person_takeover_at: "now" }]);
  });

  it("if the DB-time stamp fails too, it fails closed: every active v2 drip paused and pending v2 auto replies cancelled, reported (Astra P1)", async () => {
    mocks.rpcError = "canceling statement due to lock timeout";
    mocks.markFail = true;
    await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor });
    expect(mocks.tableUpdates).toContainEqual(["sequence_enrollments", expect.objectContaining({ status: "paused", pause_reason: "person_took_over" })]);
    expect(mocks.filters).toContainEqual(["routing_v2_engine", "v2"]);
    expect(mocks.tableUpdates).toContainEqual(["routing_v2_outbox", { status: "cancelled", cancel_reason: "human_takeover" }]);
    expect(mocks.rpcCalls).toContainEqual(["routing_v2_write_hold", { p_property_id: "p1", p_inbound_message_id: null, p_reason: "nine_needs_person", p_kind: "safety" }]);
    expect(mocks.report).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { surface: "hot_lead_takeover_stamp_fallback" } }));
  });

  it("writes the takeover marker, then pauses enrolments created by the hot route, with the person as actor", async () => {
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).toEqual({ paused: 1 });
    expect(mocks.updates[0]).toHaveProperty("last_person_takeover_at");
    // Identified by the route it was created with, never by the org's current mapping.
    expect(mocks.filters).toContainEqual(["auto_enrolled_route", "hot_book_appointment"]);
    expect(mocks.pause).toHaveBeenCalledWith(expect.anything(), { propertyId: "p1", reason: "person_took_over", actor });
  });
  it("re-labels a TEMPORARY pause (call in progress / Norma call) BEFORE pausing active rows, by database predicate, so a cleanup in between cannot undo the takeover", async () => {
    mocks.live = [{ property_id: "p1" }]; // e.g. a cleanup resumed it between the two steps
    const order: string[] = [];
    mocks.onUpdate = (v) => order.push(`update:${String(v.pause_reason ?? "marker")}`);
    mocks.pause.mockImplementationOnce(async () => {
      order.push("pause");
      return { paused: 1 };
    });
    await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor });
    expect(order).toEqual(["update:marker", "update:person_took_over", "pause"]);
    // Predicates are evaluated by the database, not from an earlier snapshot.
    expect(mocks.filters).toEqual(expect.arrayContaining([["status", "paused"], ["auto_enrolled_route", "hot_book_appointment"]]));
  });
  it("leaves a seller-reply pause (inbound_reply) as it is", async () => {
    mocks.live = [];
    await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor });
    // Only call_in_progress / norma_call are re-labelled; inbound_reply is never in the predicate.
    expect(mocks.filters).not.toContainEqual(["pause_reason", "inbound_reply"]);
  });
  it("still records the marker when there is nothing to pause, and leaves other drips alone", async () => {
    mocks.live = [];
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).toEqual({ paused: 0 });
    expect(mocks.updates[0]).toHaveProperty("last_person_takeover_at");
    expect(mocks.pause).not.toHaveBeenCalled();
  });
  it("does nothing for no leads, and never throws on a read failure", async () => {
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: [], actor })).toEqual({ paused: 0 });
    mocks.fail = true;
    await expect(pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).resolves.toEqual({ paused: 0 });
  });
});
