import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, pausePropertyEnrollments, resumeByProperty, setOutreachDispo, bookAppointment, getMemberTimezone } = vi.hoisted(() => ({
  createClient: vi.fn(),
  pausePropertyEnrollments: vi.fn(),
  resumeByProperty: vi.fn(),
  setOutreachDispo: vi.fn(),
  bookAppointment: vi.fn(),
  getMemberTimezone: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/sequences/enrollment", () => ({
  pausePropertyEnrollments,
  resumeByProperty,
}));
vi.mock("@/components/appointments/book-appointment-action", () => ({
  bookAppointment,
  getMemberTimezone,
}));
vi.mock("@/app/(dashboard)/messages/dispo-actions", () => ({ setOutreachDispo }));

import { completeSoftphoneCall, prepareManualCall } from "./actions";

describe("prepareManualCall", () => {
  beforeEach(() => {
    createClient.mockReset();
    pausePropertyEnrollments.mockReset();
    resumeByProperty.mockReset();
    setOutreachDispo.mockReset();
    bookAppointment.mockReset();
    getMemberTimezone.mockReset();
  });

  it("refuses the exact phone number of a DNC lead before creating a manual call", async () => {
    const dncContact = {
      id: "contact-dnc",
      first_name: "DNC",
      last_name: "Lead",
      entity_name: null,
      phone_1: "+18165550123",
      phone_2: null,
      phone_3: null,
      do_not_contact: true,
      sms_opted_out: false,
    };
    const property = {
      id: "property-dnc",
      address: "1 DNC Lane",
      city: "Kansas City",
      state: "MO",
      is_dnc_locked: true,
      homeowner_contact_id: dncContact.id,
      homeowner: dncContact,
    };
    const responses = [
      { data: [dncContact], error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: [property], error: null },
    ];
    createClient.mockResolvedValue({
      from: vi.fn(() => {
        const response = responses.shift() ?? { data: [], error: null };
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          in: vi.fn(() => builder),
          then: (resolve: (value: typeof response) => unknown) => Promise.resolve(response).then(resolve),
        };
        return builder;
      }),
    });

    await expect(prepareManualCall("+1 (816) 555-0123")).resolves.toEqual({
      ok: false,
      error: "This number belongs to a DNC-locked lead",
    });
    expect(pausePropertyEnrollments).not.toHaveBeenCalled();
  });

  it("runs disposition, activity, callback booking, then softphone resume in order", async () => {
    const order: string[] = [];
    setOutreachDispo.mockImplementation(async () => { order.push("disposition"); return { ok: true }; });
    getMemberTimezone.mockResolvedValue({ ok: true, data: "America/Chicago" });
    bookAppointment.mockImplementation(async () => { order.push("booking"); return { ok: true, data: { taskId: "task-1" } }; });
    resumeByProperty.mockImplementation(async () => { order.push("resume"); return { resumed: 1 }; });
    createClient.mockResolvedValue(makeActionClient(order));

    await expect(completeSoftphoneCall({
      target: {
        propertyId: "property-1",
        contactId: "contact-1",
        phoneE164: "+18165550123",
        maskedPhone: "(816) 555-0123",
        name: "Lead One",
        address: "1 Main St",
        state: "MO",
        startedAt: "2026-08-21T15:00:00.000Z",
      },
      startedAt: "2026-08-21T15:00:00.000Z",
      endedAt: "2026-08-21T15:01:00.000Z",
      durationSeconds: 60,
      outcome: "connected_human",
      disposition: "nurture",
      notes: "Call back tomorrow",
      callback: { date: "2026-08-22", time: "09:00", timeZone: "America/Chicago" },
    })).resolves.toMatchObject({ ok: true, data: { activityId: "activity-1", callbackTaskId: "task-1" } });
    expect(order).toEqual(["disposition", "activity", "booking", "resume"]);
    expect(bookAppointment).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "activity-1" }));
  });

  it("stops at the disposition rejection without writing activity or booking", async () => {
    setOutreachDispo.mockResolvedValue({ ok: false, error: "This lead is permanently read-only" });
    createClient.mockResolvedValue(makeActionClient([]));

    await expect(completeSoftphoneCall({
      target: { propertyId: "property-1", contactId: null, phoneE164: "+18165550123", maskedPhone: "(816) 555-0123", name: "Lead One", address: "1 Main St", state: "MO", startedAt: "2026-08-21T15:00:00.000Z" },
      startedAt: "2026-08-21T15:00:00.000Z",
      endedAt: "2026-08-21T15:01:00.000Z",
      durationSeconds: 60,
      outcome: "connected_human",
      disposition: "dnc",
      notes: "DNC race",
    })).resolves.toEqual({ ok: false, error: "This lead is permanently read-only" });
    expect(bookAppointment).not.toHaveBeenCalled();
    expect(resumeByProperty).not.toHaveBeenCalled();
  });
});

function makeActionClient(order: string[]) {
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
    from: vi.fn((table: string) => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        insert: vi.fn(() => { if (table === "call_activities") order.push("activity"); return builder; }),
        maybeSingle: vi.fn(async () => table === "memberships"
          ? { data: { org_id: "org-1" }, error: null }
          : { data: { id: "property-1", homeowner_contact_id: "contact-1" }, error: null }),
        single: vi.fn(async () => ({ data: { id: "activity-1" }, error: null })),
      };
      return builder;
    }),
  };
}
