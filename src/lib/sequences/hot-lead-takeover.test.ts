import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  live: [] as Array<{ property_id: string }>,
  marker: { last_person_takeover_at: null as string | null },
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
      b.eq = (c: string, v: unknown) => {
        mocks.filters.push([c, v]);
        return b;
      };
      b.maybeSingle = async () => ({ data: mocks.marker, error: null });
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(mocks.fail ? { data: null, error: { message: "db down" } } : { data: table === "sequence_enrollments" ? mocks.live : null, error: null });
      return b;
    },
  }),
}));

import { pauseHotBookAppointmentOnTakeover, pauseHotEnrollmentIfTakenOverSince } from "./hot-lead-takeover";

const actor = { actorType: "user", actorId: "u1" } as const;

beforeEach(() => {
  mocks.pause.mockClear();
  mocks.updates = [];
  mocks.filters = [];
  mocks.fail = false;
  mocks.live = [{ property_id: "p1" }];
  mocks.marker = { last_person_takeover_at: null };
});

describe("pauseHotBookAppointmentOnTakeover", () => {
  it("writes the takeover marker, then pauses enrolments created by the hot route, with the person as actor", async () => {
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).toEqual({ paused: 1 });
    expect(mocks.updates[0]).toHaveProperty("last_person_takeover_at");
    // Identified by the route it was created with, never by the org's current mapping.
    expect(mocks.filters).toContainEqual(["auto_enrolled_route", "hot_book_appointment"]);
    expect(mocks.pause).toHaveBeenCalledWith(expect.anything(), { propertyId: "p1", reason: "person_took_over", actor });
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

describe("pauseHotEnrollmentIfTakenOverSince (the enrol-vs-takeover race)", () => {
  const since = "2026-10-08T12:00:00.000Z";
  it("pauses when a person took over after the dispatch started (their pause found nothing)", async () => {
    mocks.marker = { last_person_takeover_at: "2026-10-08T12:00:01.000Z" };
    expect(await pauseHotEnrollmentIfTakenOverSince({ propertyId: "p1", since })).toEqual({ paused: 1 });
    expect(mocks.pause).toHaveBeenCalledWith(expect.anything(), { propertyId: "p1", reason: "person_took_over" });
  });
  it("leaves it running when the last takeover was before the dispatch started, or never", async () => {
    mocks.marker = { last_person_takeover_at: "2026-10-08T11:59:00.000Z" };
    expect(await pauseHotEnrollmentIfTakenOverSince({ propertyId: "p1", since })).toEqual({ paused: 0 });
    mocks.marker = { last_person_takeover_at: null };
    expect(await pauseHotEnrollmentIfTakenOverSince({ propertyId: "p1", since })).toEqual({ paused: 0 });
    expect(mocks.pause).not.toHaveBeenCalled();
  });
});
