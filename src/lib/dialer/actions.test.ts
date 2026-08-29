import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const { createClient, pausePropertyEnrollments, resumeByProperty, setOutreachDispo, bookAppointment, getMemberTimezone } = vi.hoisted(() => ({
  createClient: vi.fn(),
  pausePropertyEnrollments: vi.fn(),
  resumeByProperty: vi.fn(),
  setOutreachDispo: vi.fn(),
  bookAppointment: vi.fn(),
  getMemberTimezone: vi.fn(),
}));

const CAPABILITY_KEY = `v1:${"k".repeat(48)}`;
const RAW_JITTER_CALL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function sealCallCapability(callId: string, userId = "user-1"): string {
  const payload = Buffer.from(
    JSON.stringify({ type: "call", callId, userId }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", CAPABILITY_KEY.slice(3))
    .update(`sandra-softphone:call:${payload}`)
    .digest("base64url");
  return `v1.${payload}.${signature}`;
}

type MockActivityRow = {
  id: string;
  wrapToken?: string | null;
  jitterAttemptId?: string;
  propertyId?: string | null;
  contactId?: string | null;
  jitterSessionId?: string | null;
  operatorUserId?: string | null;
};

function softphoneCompletionInput(wrapToken: string) {
  return {
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
    notes: "Identity convergence",
    wrapToken,
  };
}

function findMockActivityByAttempt(
  rows: Map<string, MockActivityRow>,
  attemptId: string,
): MockActivityRow | undefined {
  return [...rows.values()].find((row) => row.jitterAttemptId === attemptId);
}

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

import {
  completeSoftphoneCall,
  prepareLeadCall,
  prepareManualCall,
} from "./actions";

describe("prepareManualCall", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.stubEnv("SOFTPHONE_CAPABILITY_KEY", CAPABILITY_KEY);
    vi.stubEnv("SOFTPHONE_CAPABILITY_KEY_PREVIOUS", "");
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
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }),
      },
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
      {
        propertyId: property.id,
        reason: "call_in_progress",
        actor: { actorType: "user", actorId: "user-1" },
      },
    );
  });

  it("populates the rep name for a callable manual number with no linked lead", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T15:00:00.000Z"));
    const responses = [
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ];
    createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { email: "mel.rep@bmhgroupkc.com", user_metadata: { display_name: "Mel" } } },
          error: null,
        }),
      },
      from: vi.fn(() => {
        const response = responses.shift() ?? { data: [], error: null };
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          then: (resolve: (value: typeof response) => unknown) => Promise.resolve(response).then(resolve),
        };
        return builder;
      }),
    });

    await expect(prepareManualCall("+1 (816) 555-0199")).resolves.toMatchObject({
      ok: true,
      data: {
        propertyId: null,
        repName: "Mel",
      },
    });
  });

  it("does not pause a manual call when authentication fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T15:00:00.000Z"));
    const contact = {
      id: "contact-1",
      first_name: "No",
      last_name: "Session",
      entity_name: null,
      phone_1: "+18165550123",
      phone_2: null,
      phone_3: null,
      do_not_contact: false,
      sms_opted_out: false,
    };
    const property = {
      id: "property-1",
      address: "1 Auth Lane",
      city: "Kansas City",
      state: "MO",
      is_dnc_locked: false,
      homeowner_contact_id: contact.id,
      homeowner: contact,
    };
    const responses = [
      { data: [contact], error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: [property], error: null },
    ];
    createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: { message: "expired session" },
        }),
      },
      from: vi.fn(() => {
        const response = responses.shift() ?? { data: [], error: null };
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          in: vi.fn(() => builder),
          then: (resolve: (value: typeof response) => unknown) =>
            Promise.resolve(response).then(resolve),
        };
        return builder;
      }),
    });

    await expect(prepareManualCall(contact.phone_1)).resolves.toEqual({
      ok: false,
      error: "Not signed in.",
    });
    expect(pausePropertyEnrollments).not.toHaveBeenCalled();
  });

  it("does not pause a lead call without an authenticated user", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T15:00:00.000Z"));
    const lead = {
      id: "property-1",
      address: "1 Auth Lane",
      city: "Kansas City",
      state: "MO",
      is_dnc_locked: false,
      homeowner_contact_id: "contact-1",
      homeowner: {
        id: "contact-1",
        first_name: "No",
        last_name: "Session",
        entity_name: null,
        phone_1: "+18165550123",
        phone_2: null,
        phone_3: null,
        do_not_contact: false,
        sms_opted_out: false,
      },
    };
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn().mockResolvedValue({ data: lead, error: null }),
    };
    createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: null,
        }),
      },
      from: vi.fn(() => builder),
    });

    await expect(prepareLeadCall(lead.id)).resolves.toEqual({
      ok: false,
      error: "Not signed in.",
    });
    expect(pausePropertyEnrollments).not.toHaveBeenCalled();
  });

  it("carries the authenticated rep display name into a prepared lead call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T15:00:00.000Z"));
    const lead = {
      id: "property-1",
      address: "1 Auth Lane",
      city: "Kansas City",
      state: "MO",
      is_dnc_locked: false,
      homeowner_contact_id: "contact-1",
      homeowner: {
        id: "contact-1",
        first_name: "Seller",
        last_name: "One",
        entity_name: null,
        phone_1: "+18165550123",
        phone_2: null,
        phone_3: null,
        do_not_contact: false,
        sms_opted_out: false,
      },
    };
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn().mockResolvedValue({ data: lead, error: null }),
    };
    createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { email: "mel.rep@bmhgroupkc.com", user_metadata: { display_name: "Mel" } } },
          error: null,
        }),
      },
      from: vi.fn(() => builder),
    });
    pausePropertyEnrollments.mockResolvedValue(undefined);

    await expect(prepareLeadCall(lead.id)).resolves.toMatchObject({
      ok: true,
      data: {
        repName: "Mel",
        name: "Seller One",
        address: "1 Auth Lane",
      },
    });
  });

  it("runs disposition before the activity write, then booking and softphone resume", async () => {
    const order: string[] = [];
    const activityUpserts: Array<Record<string, unknown>> = [];
    setOutreachDispo.mockImplementation(async () => { order.push("disposition"); return { ok: true }; });
    getMemberTimezone.mockResolvedValue({ ok: true, data: "America/Chicago" });
    bookAppointment.mockImplementation(async () => { order.push("booking"); return { ok: true, data: { taskId: "task-1" } }; });
    resumeByProperty.mockImplementation(async () => { order.push("resume"); return { resumed: 1 }; });
    createClient.mockResolvedValue(makeActionClient(order, undefined, undefined, undefined, undefined, activityUpserts));

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
    expect(activityUpserts[0]).toMatchObject({
      jitter_attempt_id: "sandra-11111111-1111-4111-8111-111111111111",
      wrap_token: "11111111-1111-4111-8111-111111111111",
      provider: "sandra_softphone",
    });
    expect(bookAppointment).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "11111111-1111-4111-8111-111111111111" }));
  });

  it("uses the raw Jitter call UUID from the sealed capability for the attempt identity", async () => {
    const activityUpserts: Array<Record<string, unknown>> = [];
    setOutreachDispo.mockResolvedValue({ ok: true });
    resumeByProperty.mockResolvedValue({ resumed: 1 });
    createClient.mockResolvedValue(makeActionClient([], undefined, undefined, undefined, [], activityUpserts));

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
      notes: "Capability identity",
      wrapToken: "22222222-2222-4222-8222-222222222222",
      callCapability: sealCallCapability(RAW_JITTER_CALL_ID),
    })).resolves.toMatchObject({ ok: true, data: { activityId: "activity-1" } });

    expect(activityUpserts[0]).toMatchObject({
      jitter_attempt_id: `sandra-${RAW_JITTER_CALL_ID}`,
      wrap_token: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("converges wrap-up-first and writeback-first on one softphone activity row", async () => {
    const wrapToken = "33333333-3333-4333-8333-333333333333";
    const callCapability = sealCallCapability(RAW_JITTER_CALL_ID);
    const attemptId = `sandra-${RAW_JITTER_CALL_ID}`;
    const wrapUpFirstRows = new Map<string, MockActivityRow>();
    setOutreachDispo.mockResolvedValue({ ok: true });
    resumeByProperty.mockResolvedValue({ resumed: 1 });
    createClient.mockResolvedValue(makeActionClient([], wrapUpFirstRows));

    await expect(completeSoftphoneCall({
      ...softphoneCompletionInput(wrapToken),
      callCapability,
    })).resolves.toMatchObject({ ok: true, data: { activityId: "activity-1" } });
    expect(wrapUpFirstRows.size).toBe(1);
    expect([...wrapUpFirstRows.values()][0]).toMatchObject({
      id: "activity-1",
      jitterAttemptId: attemptId,
      wrapToken,
    });

    const writebackRow = [...wrapUpFirstRows.values()][0];
    writebackRow.jitterSessionId = "sandra-softphone-session-scope:run-1";
    expect(findMockActivityByAttempt(wrapUpFirstRows, attemptId)?.id).toBe("activity-1");

  const writebackFirstRows = new Map<string, MockActivityRow>([
    ["writeback-row", {
        id: "activity-writeback",
        wrapToken: null,
        jitterAttemptId: attemptId,
        propertyId: "property-1",
        contactId: "contact-1",
        jitterSessionId: "sandra-softphone-session-scope:run-1",
      }],
    ]);
    createClient.mockResolvedValue(makeActionClient([], writebackFirstRows));

    await expect(completeSoftphoneCall({
      ...softphoneCompletionInput(wrapToken),
      callCapability,
    })).resolves.toMatchObject({ ok: true, data: { activityId: "activity-writeback" } });
    expect(writebackFirstRows.size).toBe(1);
    expect(findMockActivityByAttempt(writebackFirstRows, attemptId)).toMatchObject({
      id: "activity-writeback",
      wrapToken,
      jitterSessionId: "sandra-softphone-session-scope:run-1",
    });
  });

  it("does not adopt a matching attempt owned by another operator", async () => {
    const attemptId = `sandra-${RAW_JITTER_CALL_ID}`;
    const rows = new Map<string, MockActivityRow>([
      ["foreign-row", {
        id: "activity-foreign",
        wrapToken: null,
        jitterAttemptId: attemptId,
        propertyId: "property-1",
        contactId: "contact-1",
        operatorUserId: "user-2",
      }],
    ]);
    setOutreachDispo.mockResolvedValue({ ok: true });
    resumeByProperty.mockResolvedValue({ resumed: 1 });
    createClient.mockResolvedValue(makeActionClient([], rows));

    await expect(completeSoftphoneCall({
      ...softphoneCompletionInput("44444444-4444-4444-8444-444444444444"),
      callCapability: sealCallCapability(RAW_JITTER_CALL_ID),
    })).resolves.toEqual({ ok: false, error: "The call activity was not saved." });
    expect(findMockActivityByAttempt(rows, attemptId)).toMatchObject({ operatorUserId: "user-2" });
  });

  it("does not overwrite a same-operator attempt with a different wrap token", async () => {
    const attemptId = `sandra-${RAW_JITTER_CALL_ID}`;
    const rows = new Map<string, MockActivityRow>([
      ["completed-row", {
        id: "activity-completed",
        wrapToken: "66666666-6666-4666-8666-666666666666",
        jitterAttemptId: attemptId,
        propertyId: "property-1",
        contactId: "contact-1",
        operatorUserId: "user-1",
      }],
    ]);
    createClient.mockResolvedValue(makeActionClient([], rows));

    await expect(completeSoftphoneCall({
      ...softphoneCompletionInput("77777777-7777-4777-8777-777777777777"),
      callCapability: sealCallCapability(RAW_JITTER_CALL_ID),
    })).resolves.toEqual({ ok: false, error: "The call activity was not saved." });
    expect(setOutreachDispo).not.toHaveBeenCalled();
    expect(findMockActivityByAttempt(rows, attemptId)).toMatchObject({
      wrapToken: "66666666-6666-4666-8666-666666666666",
    });
  });

  it("keeps writeback-first lead links when the wrap-up omits them", async () => {
    const attemptId = `sandra-${RAW_JITTER_CALL_ID}`;
    const rows = new Map<string, MockActivityRow>([
      ["writeback-row", {
        id: "activity-writeback",
        wrapToken: null,
        jitterAttemptId: attemptId,
        propertyId: "property-1",
        contactId: "contact-1",
        operatorUserId: null,
      }],
    ]);
    setOutreachDispo.mockResolvedValue({ ok: true });
    resumeByProperty.mockResolvedValue({ resumed: 1 });
    createClient.mockResolvedValue(makeActionClient([], rows));

    await expect(completeSoftphoneCall({
      ...softphoneCompletionInput("55555555-5555-4555-8555-555555555555"),
      target: {
        ...softphoneCompletionInput("unused").target,
        propertyId: null,
        contactId: null,
      },
      callCapability: sealCallCapability(RAW_JITTER_CALL_ID),
    })).resolves.toMatchObject({ ok: true, data: { activityId: "activity-writeback" } });
    expect(findMockActivityByAttempt(rows, attemptId)).toMatchObject({
      propertyId: "property-1",
      contactId: "contact-1",
    });
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
  activityRows = new Map<string, MockActivityRow>(),
  propertyUpdates: Array<Record<string, unknown>> = [],
  onPropertyUpdate?: (values: Record<string, unknown>) => void,
  propertyUpdateErrors: Array<{ message: string } | null> = [],
  activityUpserts: Array<Record<string, unknown>> = [],
) {
  const storedRows = new Map<string, MockActivityRow>();
  for (const [key, row] of activityRows) {
    const wrapToken = row.wrapToken === undefined ? key : row.wrapToken;
    storedRows.set(row.id, {
      ...row,
      wrapToken,
      jitterAttemptId: row.jitterAttemptId ?? `sandra-${wrapToken ?? key}`,
      propertyId: row.propertyId ?? "property-1",
      contactId: row.contactId ?? "contact-1",
      operatorUserId: row.operatorUserId === undefined ? (wrapToken ? "user-1" : null) : row.operatorUserId,
    });
  }
  const syncActivityRows = () => {
    activityRows.clear();
    for (const row of storedRows.values()) {
      activityRows.set(row.wrapToken ?? `row:${row.id}`, row);
    }
  };
  syncActivityRows();

  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
    from: vi.fn((table: string) => {
      let insertedActivity: { id: string } | null = null;
      let insertError: { code: string; message: string } | null = null;
      let updateError: { message: string } | null = null;
      let pendingActivityUpdate: Record<string, unknown> | null = null;
      const filters = new Map<string, unknown>();
      let operatorScope: string | null = null;
      let activityMatch: { operatorUserId: string; wrapToken: string } | null = null;
      const findActivity = () => [...storedRows.values()].find((row) => {
        const id = filters.get("id");
        const wrapToken = filters.get("wrap_token");
        const attemptId = filters.get("jitter_attempt_id");
        const operatorUserId = filters.get("operator_user_id");
        return (
          (typeof id !== "string" || row.id === id) &&
          (typeof wrapToken !== "string" || row.wrapToken === wrapToken) &&
          (typeof attemptId !== "string" || row.jitterAttemptId === attemptId) &&
          (typeof operatorUserId !== "string" || row.operatorUserId === operatorUserId) &&
          (!operatorScope || row.operatorUserId === operatorScope || row.operatorUserId === null) &&
          (!activityMatch ||
            (row.operatorUserId === activityMatch.operatorUserId && row.wrapToken === activityMatch.wrapToken) ||
            (row.operatorUserId === activityMatch.operatorUserId && row.wrapToken === null) ||
            (row.operatorUserId === null && row.wrapToken === null))
        );
      });
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: unknown) => { filters.set(column, value); return builder; }),
        or: vi.fn((expression: string) => {
          const match = expression.match(/^operator_user_id\.eq\.([^,]+),operator_user_id\.is\.null$/);
          operatorScope = match?.[1] ?? null;
          const activityMatchExpression = expression.match(
            /^and\(operator_user_id\.eq\.([^,]+),wrap_token\.eq\.([^\)]+)\),and\(operator_user_id\.eq\.[^,]+,wrap_token\.is\.null\),and\(operator_user_id\.is\.null,wrap_token\.is\.null\)$/,
          );
          activityMatch = activityMatchExpression
            ? {
                operatorUserId: activityMatchExpression[1],
                wrapToken: activityMatchExpression[2],
              }
            : null;
          return builder;
        }),
        delete: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        insert: vi.fn((values: Record<string, unknown>) => {
          if (table !== "call_activities") return builder;
          activityUpserts.push(values);
          const existing = [...storedRows.values()].find((row) =>
            row.jitterAttemptId === values.jitter_attempt_id,
          );
          if (existing) {
            insertError = { code: "23505", message: "duplicate softphone attempt" };
            return builder;
          }
          insertedActivity = { id: `activity-${storedRows.size + 1}` };
          storedRows.set(insertedActivity.id, {
            id: insertedActivity.id,
            wrapToken: values.wrap_token as string,
            jitterAttemptId: String(values.jitter_attempt_id),
            propertyId: typeof values.property_id === "string" ? values.property_id : null,
            contactId: typeof values.contact_id === "string" ? values.contact_id : null,
            operatorUserId: typeof values.operator_user_id === "string" ? values.operator_user_id : null,
          });
          syncActivityRows();
          order.push("activity");
          return builder;
        }),
        update: vi.fn((values: Record<string, unknown>) => {
          if (table === "properties") {
            propertyUpdates.push(values);
            updateError = propertyUpdateErrors.shift() ?? null;
            if (!updateError) onPropertyUpdate?.(values);
          } else if (table === "call_activities") {
            pendingActivityUpdate = values;
          }
          return builder;
        }),
        then: (resolve: (value: { data: null; error: { message: string } | null }) => unknown) =>
          Promise.resolve({ data: null, error: updateError }).then(resolve),
        upsert: vi.fn((values: { wrap_token?: string } & Record<string, unknown>) => {
          if (table !== "call_activities" || !values.wrap_token) return builder;
          activityUpserts.push(values);
          const existing = [...storedRows.values()].find((row) =>
            row.jitterAttemptId === values.jitter_attempt_id || row.wrapToken === values.wrap_token,
          );
          insertedActivity = existing ? null : { id: `activity-${storedRows.size + 1}` };
          if (!existing && insertedActivity) {
            storedRows.set(insertedActivity.id, {
              id: insertedActivity.id,
              wrapToken: values.wrap_token,
              jitterAttemptId: String(values.jitter_attempt_id),
              propertyId: typeof values.property_id === "string" ? values.property_id : null,
              contactId: typeof values.contact_id === "string" ? values.contact_id : null,
            });
            syncActivityRows();
            order.push("activity");
          }
          return builder;
        }),
        maybeSingle: vi.fn(async () => {
          if (table === "memberships") return { data: { org_id: "org-1" }, error: null };
          if (table === "properties") return { data: { id: "property-1", homeowner_contact_id: "contact-1" }, error: null };
          if (table === "call_activities") {
            if (pendingActivityUpdate) {
              const existing = findActivity();
              if (!existing) return { data: null, error: null };
              const previousWrapToken = existing.wrapToken;
              Object.assign(existing, {
                wrapToken: pendingActivityUpdate.wrap_token as string | null | undefined,
                jitterAttemptId: String(pendingActivityUpdate.jitter_attempt_id ?? existing.jitterAttemptId),
                propertyId: pendingActivityUpdate.property_id as string | null | undefined,
                contactId: pendingActivityUpdate.contact_id as string | null | undefined,
                operatorUserId: pendingActivityUpdate.operator_user_id as string | null | undefined,
                jitterSessionId: existing.jitterSessionId,
              });
              if (previousWrapToken !== existing.wrapToken) syncActivityRows();
              pendingActivityUpdate = null;
              return { data: { id: existing.id }, error: null };
            }
            if (insertError) return { data: null, error: insertError };
            return {
              data: insertedActivity ?? (findActivity() ? {
                id: findActivity()!.id,
                property_id: findActivity()!.propertyId,
                contact_id: findActivity()!.contactId,
              } : null),
              error: insertError,
            };
          }
          return { data: null, error: null };
        }),
        single: vi.fn(async () => ({ data: { id: "activity-1" }, error: null })),
      };
      return builder;
    }),
  };
}
