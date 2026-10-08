import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  live: [] as Array<{ id?: string; property_id: string; status?: string; pause_reason?: string | null }>,
  marker: { last_person_takeover_at: null as string | null },
  newerInbound: [] as Array<{ id: string }>,
  pause: vi.fn(async (..._a: unknown[]) => ({ paused: 1 })),
  updates: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, unknown]>,
  fail: false,
}));

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("./enrollment", () => ({ pausePropertyEnrollments: mocks.pause }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.update = (v: Record<string, unknown>) => {
        mocks.updates.push(v);
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
        resolve(mocks.fail ? { data: null, error: { message: "db down" } } : { data: table === "sequence_enrollments" ? mocks.live : table === "messages" ? mocks.newerInbound : null, error: null });
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
  mocks.live = [{ property_id: "p1" }];
  mocks.marker = { last_person_takeover_at: null };
  mocks.newerInbound = [];
});

describe("pauseHotBookAppointmentOnTakeover", () => {
  it("writes the takeover marker, then pauses enrolments created by the hot route, with the person as actor", async () => {
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).toEqual({ paused: 1 });
    expect(mocks.updates[0]).toHaveProperty("last_person_takeover_at");
    // Identified by the route it was created with, never by the org's current mapping.
    expect(mocks.filters).toContainEqual(["auto_enrolled_route", "hot_book_appointment"]);
    expect(mocks.pause).toHaveBeenCalledWith(expect.anything(), { propertyId: "p1", reason: "person_took_over", actor });
  });
  it("re-labels a TEMPORARY pause (call in progress / Norma call) so call cleanup can never resume it", async () => {
    mocks.live = [{ id: "e1", property_id: "p1", status: "paused", pause_reason: "call_in_progress" }];
    await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor });
    expect(mocks.updates).toContainEqual(expect.objectContaining({ pause_reason: "person_took_over" }));
  });
  it("leaves a seller-reply pause (inbound_reply) as it is", async () => {
    mocks.live = [{ id: "e1", property_id: "p1", status: "paused", pause_reason: "inbound_reply" }];
    await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor });
    expect(mocks.updates.filter((u) => "pause_reason" in u)).toEqual([]);
  });
  it("still records the marker when there is nothing to pause, and leaves other drips alone", async () => {
    mocks.live = [];
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).toEqual({ paused: 0 });
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.pause).not.toHaveBeenCalled();
  });
  it("does nothing for no leads, and never throws on a read failure", async () => {
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: [], actor })).toEqual({ paused: 0 });
    mocks.fail = true;
    await expect(pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).resolves.toEqual({ paused: 0 });
  });
});
