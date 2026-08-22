import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("keeps an SMS-opted-out contact callable by voice when no voice DNC applies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T15:00:00.000Z"));
    const smsOptedOutContact = {
      id: "contact-sms-opted-out",
      first_name: "Voice",
      last_name: "Allowed",
      entity_name: null,
      phone_1: "+18165550123",
      phone_2: null,
      phone_3: null,
      do_not_contact: false,
      sms_opted_out: true,
    };
    const property = {
      id: "property-voice-allowed",
      address: "1 Voice Lane",
      city: "Kansas City",
      state: "MO",
      is_dnc_locked: false,
      homeowner_contact_id: smsOptedOutContact.id,
      homeowner: smsOptedOutContact,
    };
    const responses = [
      { data: [smsOptedOutContact], error: null },
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

    const result = await prepareManualCall("+1 (816) 555-0123");

    expect(result).toMatchObject({
      ok: true,
      data: {
        propertyId: property.id,
        contactId: smsOptedOutContact.id,
        phoneE164: smsOptedOutContact.phone_1,
      },
    });
    expect(pausePropertyEnrollments).toHaveBeenCalledWith(
      expect.anything(),
      { propertyId: property.id, reason: "call_in_progress" },
    );
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
      wrapToken: "11111111-1111-4111-8111-111111111111",
      callback: { date: "2026-08-22", time: "09:00", timeZone: "America/Chicago" },
    })).resolves.toMatchObject({ ok: true, data: { activityId: "activity-1", callbackTaskId: "task-1" } });
    expect(order).toEqual(["disposition", "activity", "booking", "resume"]);
    expect(bookAppointment).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "11111111-1111-4111-8111-111111111111" }));
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
      wrapToken: "22222222-2222-4222-8222-222222222222",
    })).resolves.toEqual({ ok: false, error: "This lead is permanently read-only" });
    expect(bookAppointment).not.toHaveBeenCalled();
    expect(resumeByProperty).not.toHaveBeenCalled();
  });

  it("reuses one activity row and one appointment across a full same-token retry", async () => {
    const activityRows = new Map<string, { id: string }>();
    const appointmentRows = new Map<string, string>();
    let propertyDisposition = "new_lead";
    setOutreachDispo.mockImplementation(async (_propertyId: string, disposition: string) => {
      propertyDisposition = disposition;
      return { ok: true };
    });
    getMemberTimezone.mockResolvedValue({ ok: true, data: "America/Chicago" });
    bookAppointment.mockImplementation(async (input: { idempotencyKey?: string }) => {
      const key = input.idempotencyKey!;
      const duplicate = appointmentRows.has(key);
      if (!duplicate) {
        appointmentRows.set(key, `task-${appointmentRows.size + 1}`);
        propertyDisposition = "booked_appointment";
      }
      return { ok: true, data: { taskId: appointmentRows.get(key), duplicate } };
    });
    createClient.mockResolvedValue(makeActionClient([], activityRows));

    const input = {
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
      outcome: "connected_human" as const,
      disposition: "nurture" as const,
      notes: "Call back tomorrow",
      wrapToken: "33333333-3333-4333-8333-333333333333",
      callback: { date: "2026-08-22", time: "09:00", timeZone: "America/Chicago" },
    };

    const first = await completeSoftphoneCall(input);
    const retry = await completeSoftphoneCall(input);

    expect(first).toMatchObject({ ok: true, data: { activityId: "activity-1", callbackTaskId: "task-1" } });
    expect(retry).toEqual(first);
    expect(activityRows.size).toBe(1);
    expect(appointmentRows.size).toBe(1);
    expect(propertyDisposition).toBe("booked_appointment");
    expect(setOutreachDispo).toHaveBeenCalledTimes(1);
    expect(bookAppointment).toHaveBeenCalledTimes(2);
    expect(bookAppointment).toHaveBeenNthCalledWith(1, expect.objectContaining({ idempotencyKey: input.wrapToken }));
    expect(bookAppointment).toHaveBeenNthCalledWith(2, expect.objectContaining({ idempotencyKey: input.wrapToken }));
  });

  it("preserves booked_appointment across concurrent same-token retries", async () => {
    const activityRows = new Map<string, { id: string }>();
    const appointmentRows = new Map<string, string>();
    const propertyUpdates: Array<Record<string, unknown>> = [];
    let propertyDisposition = "new_lead";
    let dispositionCalls = 0;
    let signalSecondDispositionStarted!: () => void;
    const secondDispositionStarted = new Promise<void>((resolve) => { signalSecondDispositionStarted = resolve; });
    let releaseSecondDisposition!: () => void;
    const secondDispositionRelease = new Promise<void>((resolve) => { releaseSecondDisposition = resolve; });

    setOutreachDispo.mockImplementation(async (_propertyId: string, disposition: string) => {
      dispositionCalls += 1;
      if (dispositionCalls === 2) {
        signalSecondDispositionStarted();
        await secondDispositionRelease;
      }
      propertyDisposition = disposition;
      return { ok: true };
    });
    getMemberTimezone.mockResolvedValue({ ok: true, data: "America/Chicago" });
    bookAppointment.mockImplementation(async (input: { idempotencyKey?: string }) => {
      const key = input.idempotencyKey!;
      const duplicate = appointmentRows.has(key);
      if (!duplicate) {
        await secondDispositionStarted;
        appointmentRows.set(key, "task-1");
        propertyDisposition = "booked_appointment";
        releaseSecondDisposition();
      }
      return { ok: true, data: { taskId: appointmentRows.get(key), duplicate } };
    });
    createClient.mockResolvedValue(makeActionClient(
      [],
      activityRows,
      propertyUpdates,
      (values) => {
        if (typeof values.outreach_dispo === "string") propertyDisposition = values.outreach_dispo;
      },
    ));

    const input = {
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
      outcome: "connected_human" as const,
      disposition: "nurture" as const,
      notes: "Concurrent callback retry",
      wrapToken: "44444444-4444-4444-8444-444444444444",
      callback: { date: "2026-08-22", time: "09:00", timeZone: "America/Chicago" },
    };

    const [first, retry] = await Promise.all([
      completeSoftphoneCall(input),
      completeSoftphoneCall(input),
    ]);

    expect(first).toMatchObject({ ok: true, data: { activityId: "activity-1", callbackTaskId: "task-1" } });
    expect(retry).toEqual(first);
    expect(activityRows.size).toBe(1);
    expect(appointmentRows.size).toBe(1);
    expect(propertyDisposition).toBe("booked_appointment");
    expect(propertyUpdates).toEqual([
      expect.objectContaining({ outreach_dispo: "booked_appointment" }),
    ]);
  });

  it("retries a failed booked-disposition repair on the next same-token replay", async () => {
    const wrapToken = "55555555-5555-4555-8555-555555555555";
    const activityRows = new Map([[wrapToken, { id: "activity-1" }]]);
    const appointmentRows = new Map([[wrapToken, "task-1"]]);
    const propertyUpdates: Array<Record<string, unknown>> = [];
    let propertyDisposition = "nurture";

    getMemberTimezone.mockResolvedValue({ ok: true, data: "America/Chicago" });
    bookAppointment.mockImplementation(async (input: { idempotencyKey?: string }) => ({
      ok: true,
      data: {
        taskId: appointmentRows.get(input.idempotencyKey!),
        duplicate: true,
      },
    }));
    createClient.mockResolvedValue(makeActionClient(
      [],
      activityRows,
      propertyUpdates,
      (values) => {
        if (typeof values.outreach_dispo === "string") propertyDisposition = values.outreach_dispo;
      },
      [{ message: "restore connection lost" }, null],
    ));

    const input = {
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
      outcome: "connected_human" as const,
      disposition: "nurture" as const,
      notes: "Retry callback repair",
      wrapToken,
      callback: { date: "2026-08-22", time: "09:00", timeZone: "America/Chicago" },
    };

    await expect(completeSoftphoneCall(input)).resolves.toEqual({
      ok: false,
      error: "restore connection lost",
    });
    expect(propertyDisposition).toBe("nurture");

    await expect(completeSoftphoneCall(input)).resolves.toMatchObject({
      ok: true,
      data: { activityId: "activity-1", callbackTaskId: "task-1" },
    });
    expect(activityRows.size).toBe(1);
    expect(appointmentRows.size).toBe(1);
    expect(propertyDisposition).toBe("booked_appointment");
    expect(propertyUpdates).toHaveLength(2);
    expect(setOutreachDispo).not.toHaveBeenCalled();
  });
});

function makeActionClient(
  order: string[],
  activityRows = new Map<string, { id: string }>(),
  propertyUpdates: Array<Record<string, unknown>> = [],
  onPropertyUpdate?: (values: Record<string, unknown>) => void,
  propertyUpdateErrors: Array<{ message: string } | null> = [],
) {
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
    from: vi.fn((table: string) => {
      let insertedActivity: { id: string } | null = null;
      let updateError: { message: string } | null = null;
      const filters = new Map<string, unknown>();
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: unknown) => { filters.set(column, value); return builder; }),
        limit: vi.fn(() => builder),
        insert: vi.fn(() => { if (table === "call_activities") order.push("activity"); return builder; }),
        update: vi.fn((values: Record<string, unknown>) => {
          if (table === "properties") {
            propertyUpdates.push(values);
            updateError = propertyUpdateErrors.shift() ?? null;
            if (!updateError) onPropertyUpdate?.(values);
          }
          return builder;
        }),
        then: (resolve: (value: { data: null; error: { message: string } | null }) => unknown) =>
          Promise.resolve({ data: null, error: updateError }).then(resolve),
        upsert: vi.fn((values: { wrap_token?: string }) => {
          if (table !== "call_activities" || !values.wrap_token) return builder;
          insertedActivity = activityRows.get(values.wrap_token) ?? null;
          if (!insertedActivity) {
            insertedActivity = { id: `activity-${activityRows.size + 1}` };
            activityRows.set(values.wrap_token, insertedActivity);
            order.push("activity");
          } else {
            insertedActivity = null;
          }
          return builder;
        }),
        maybeSingle: vi.fn(async () => {
          if (table === "memberships") return { data: { org_id: "org-1" }, error: null };
          if (table === "properties") return { data: { id: "property-1", homeowner_contact_id: "contact-1" }, error: null };
          if (table === "call_activities") {
            const existing = filters.get("wrap_token");
            return { data: insertedActivity ?? (typeof existing === "string" ? activityRows.get(existing) ?? null : null), error: null };
          }
          return { data: null, error: null };
        }),
        single: vi.fn(async () => ({ data: { id: "activity-1" }, error: null })),
      };
      return builder;
    }),
  };
}
