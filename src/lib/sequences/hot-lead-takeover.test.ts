import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  live: [] as Array<{ property_id: string; org_id: string; sequence_id: string }>,
  cfgs: [] as Array<{ org_id: string; nurture_drip_hot_book_appointment_sequence_id: string | null }>,
  pause: vi.fn(async (..._a: unknown[]) => ({ paused: 1 })),
  fail: false,
}));

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("./enrollment", () => ({ pausePropertyEnrollments: mocks.pause }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.in = () => b;
      b.eq = () => b;
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(
          mocks.fail
            ? { data: null, error: { message: "db down" } }
            : { data: table === "sequence_enrollments" ? mocks.live : mocks.cfgs, error: null },
        );
      return b;
    },
  }),
}));

import { pauseHotBookAppointmentOnTakeover } from "./hot-lead-takeover";

const actor = { actorType: "user", actorId: "u1" } as const;

beforeEach(() => {
  mocks.pause.mockClear();
  mocks.fail = false;
  mocks.live = [{ property_id: "p1", org_id: "o1", sequence_id: "hot" }];
  mocks.cfgs = [{ org_id: "o1", nurture_drip_hot_book_appointment_sequence_id: "hot" }];
});

describe("pauseHotBookAppointmentOnTakeover", () => {
  it("pauses the live Book appointment enrolment with reason person_took_over and the person as actor", async () => {
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).toEqual({ paused: 1 });
    expect(mocks.pause).toHaveBeenCalledWith(expect.anything(), { propertyId: "p1", reason: "person_took_over", actor });
  });
  it("leaves any other drip alone (a person assigning a Maybe later lead does not stop it)", async () => {
    mocks.live = [{ property_id: "p1", org_id: "o1", sequence_id: "maybe-later" }];
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).toEqual({ paused: 0 });
    expect(mocks.pause).not.toHaveBeenCalled();
  });
  it("does nothing when the org has no Book appointment drip mapped, or there are no leads", async () => {
    mocks.cfgs = [{ org_id: "o1", nurture_drip_hot_book_appointment_sequence_id: null }];
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).toEqual({ paused: 0 });
    expect(await pauseHotBookAppointmentOnTakeover({ propertyIds: [], actor })).toEqual({ paused: 0 });
    expect(mocks.pause).not.toHaveBeenCalled();
  });
  it("never throws: a read failure is reported and the person's action carries on", async () => {
    mocks.fail = true;
    await expect(pauseHotBookAppointmentOnTakeover({ propertyIds: ["p1"], actor })).resolves.toEqual({ paused: 0 });
  });
});
