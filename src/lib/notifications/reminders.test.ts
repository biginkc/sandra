import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createNotification: vi.fn(),
  dispatchAppointmentReminderSlack: vi.fn(),
  sendRepSmsReminder: vi.fn(),
  loadIntegrationPrefs: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("./dispatch", () => ({ createNotification: mocks.createNotification }));
vi.mock("@/lib/integrations/slack/dispatch", () => ({
  dispatchAppointmentReminderSlack: mocks.dispatchAppointmentReminderSlack,
  buildTaskDeepLink: (taskId: string) => `https://sandra-sooty.vercel.app/tasks/${taskId}`,
}));
vi.mock("./rep-sms", () => ({ sendRepSmsReminder: mocks.sendRepSmsReminder }));
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs: mocks.loadIntegrationPrefs }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import { deliverAppointmentReminder, type ClaimedReminderRow } from "./reminders";

function baseRow(overrides: Partial<ClaimedReminderRow> = {}): ClaimedReminderRow {
  return {
    deliveryId: "delivery-1",
    taskId: "task-1",
    orgId: "org-1",
    channel: "bell",
    attempts: 0,
    claimToken: null,
    claimedStatus: null,
    taskTitle: "Walkthrough with seller",
    taskDueAt: "2026-08-15T20:00:00.000Z",
    taskEndAt: "2026-08-15T20:30:00.000Z",
    assigneeId: "assignee-1",
    assigneeTimezone: "America/Chicago",
    assigneeReminderPhone: null,
    ...overrides,
  };
}

/** Fake admin Supabase client: only
 *  `.from("task_reminder_deliveries").update(...).eq(...).select("id")` is
 *  exercised by the worker's markDelivery helper. `matchedRows` controls
 *  how many rows `.select("id")` reports as affected — 1 (default) for an
 *  ordinary successful write, 0 to simulate a fenced write losing the race
 *  (lease reclaimed by another sweep). */
function fakeSupabase(
  opts: { updateError?: { message: string } | null; matchedRows?: number } = {},
) {
  const updateError = opts.updateError ?? null;
  const matchedRows = opts.matchedRows ?? 1;
  const updates: { table: string; payload: unknown; eqs: [string, unknown][] }[] = [];
  const from = vi.fn((table: string) => ({
    update: vi.fn((payload: unknown) => {
      const eqs: [string, unknown][] = [];
      const record = { table, payload, eqs };
      updates.push(record);
      const builder = {
        eq: vi.fn((column: string, value: unknown) => {
          eqs.push([column, value]);
          return builder;
        }),
        select: vi.fn(async () => ({
          data: updateError
            ? null
            : Array.from({ length: matchedRows }, (_, i) => ({ id: `row-${i}` })),
          error: updateError,
        })),
      };
      return builder;
    }),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { updates, from } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createNotification.mockResolvedValue({ inserted: 1, conflict: false });
  mocks.dispatchAppointmentReminderSlack.mockResolvedValue({
    sent: true,
    channel: "D123",
    messageTs: "1710000000.000100",
  });
  mocks.sendRepSmsReminder.mockResolvedValue({ ok: true, externalId: "sms-ext-1" });
  mocks.loadIntegrationPrefs.mockResolvedValue({
    slackEnabled: true,
    calendarEnabled: true,
    timezone: "America/Chicago",
    smsRemindersEnabled: true,
    reminderPhone: "+18165551234",
  });
});

describe("deliverAppointmentReminder — bell", () => {
  it("calls createNotification with task_appointment_reminder and marks the delivery sent", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({ channel: "bell" });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(mocks.createNotification).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        orgId: "org-1",
        eventType: "task_appointment_reminder",
        entityType: "task",
        entityId: "task-1",
        recipients: ["assignee-1"],
        payload: expect.objectContaining({
          taskTitle: "Walkthrough with seller",
          dueAt: row.taskDueAt,
          timezone: "America/Chicago",
        }),
      }),
    );
    expect(outcome).toEqual({ status: "sent", deliveryId: "delivery-1", channel: "bell" });
    expect(supabase.updates[0]).toMatchObject({
      table: "task_reminder_deliveries",
      payload: expect.objectContaining({ status: "sent", attempts: 1 }),
    });
  });

  it("still marks sent when createNotification reports a CONFIRMED duplicate (conflict: true) — retry of an already-delivered bell", async () => {
    mocks.createNotification.mockResolvedValueOnce({ inserted: 0, conflict: true });
    const supabase = fakeSupabase();

    const outcome = await deliverAppointmentReminder(supabase, baseRow({ channel: "bell" }));

    expect(outcome.status).toBe("sent");
    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({ status: "sent" }),
    });
  });

  it("marks failed (retryable) when createNotification reports inserted: 0 with NO conflict — a transport/RLS/schema error, not a dedupe", async () => {
    mocks.createNotification.mockResolvedValueOnce({ inserted: 0, conflict: false });
    const supabase = fakeSupabase();

    const outcome = await deliverAppointmentReminder(supabase, baseRow({ channel: "bell", attempts: 1 }));

    expect(outcome).toEqual({
      status: "failed",
      deliveryId: "delivery-1",
      channel: "bell",
      error: "notification insert failed",
    });
    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({ status: "failed", attempts: 2, last_error: "notification insert failed" }),
    });
  });
});

describe("deliverAppointmentReminder — slack", () => {
  it("dispatches via dispatchAppointmentReminderSlack and marks sent with the messageTs on success", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({ channel: "slack" });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(mocks.dispatchAppointmentReminderSlack).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        assigneeId: "assignee-1",
        taskTitle: "Walkthrough with seller",
        dueAt: row.taskDueAt,
        timezone: "America/Chicago",
        deepLink: "https://sandra-sooty.vercel.app/tasks/task-1",
      }),
    );
    expect(outcome).toEqual({
      status: "sent",
      deliveryId: "delivery-1",
      channel: "slack",
      providerMessageId: "1710000000.000100",
    });
    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({
        status: "sent",
        provider_message_id: "1710000000.000100",
      }),
    });
  });

  it("marks failed with the reason when Slack dispatch doesn't send", async () => {
    mocks.dispatchAppointmentReminderSlack.mockResolvedValueOnce({
      sent: false,
      reason: "pref_disabled",
    });
    const supabase = fakeSupabase();

    const outcome = await deliverAppointmentReminder(supabase, baseRow({ channel: "slack" }));

    expect(outcome).toEqual({
      status: "failed",
      deliveryId: "delivery-1",
      channel: "slack",
      error: "pref_disabled",
    });
    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({ status: "failed", last_error: "pref_disabled" }),
    });
  });
});

describe("deliverAppointmentReminder — sms", () => {
  it("fails closed with no provider call when the LIVE sms_reminder pref is disabled", async () => {
    mocks.loadIntegrationPrefs.mockResolvedValueOnce({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Chicago",
      smsRemindersEnabled: false,
      reminderPhone: "+18165551234",
    });
    const supabase = fakeSupabase();
    const row = baseRow({ channel: "sms" });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(mocks.sendRepSmsReminder).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "failed",
      deliveryId: "delivery-1",
      channel: "sms",
      error: "sms reminders disabled",
    });
  });

  it("fails closed with no provider call when the LIVE phone number is absent", async () => {
    mocks.loadIntegrationPrefs.mockResolvedValueOnce({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Chicago",
      smsRemindersEnabled: true,
      reminderPhone: null,
    });
    const supabase = fakeSupabase();
    const row = baseRow({ channel: "sms", assigneeReminderPhone: "+18165551234" });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(mocks.sendRepSmsReminder).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "failed",
      deliveryId: "delivery-1",
      channel: "sms",
      error: "no reminder phone on file",
    });
  });

  it("sends to the LIVE phone number (not the possibly-stale claimed value) and marks sent with the provider message id", async () => {
    mocks.loadIntegrationPrefs.mockResolvedValueOnce({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Chicago",
      smsRemindersEnabled: true,
      reminderPhone: "+18165559999",
    });
    const supabase = fakeSupabase();
    const row = baseRow({ channel: "sms", assigneeReminderPhone: "+18165551234" });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(mocks.sendRepSmsReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+18165559999",
        body: expect.stringContaining("Appointment in 30 min: Walkthrough with seller"),
      }),
    );
    expect(outcome).toEqual({
      status: "sent",
      deliveryId: "delivery-1",
      channel: "sms",
      providerMessageId: "sms-ext-1",
    });
  });

  it("marks failed with the provider's message when the send fails (e.g. fail-closed on env)", async () => {
    mocks.sendRepSmsReminder.mockResolvedValueOnce({
      ok: false,
      reason: "not_configured",
      message: "REP_SMS_FROM_NUMBER or SENDILLO_API_KEY is not set.",
    });
    const supabase = fakeSupabase();
    const row = baseRow({ channel: "sms" });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(outcome).toEqual({
      status: "failed",
      deliveryId: "delivery-1",
      channel: "sms",
      error: "REP_SMS_FROM_NUMBER or SENDILLO_API_KEY is not set.",
    });
  });
});

describe("deliverAppointmentReminder — defense in depth", () => {
  it("never throws: an unexpected exception from a channel's provider call is caught, delivery marked failed", async () => {
    mocks.dispatchAppointmentReminderSlack.mockRejectedValueOnce(new Error("transport blew up"));
    const supabase = fakeSupabase();

    const outcome = await deliverAppointmentReminder(supabase, baseRow({ channel: "slack" }));

    expect(outcome).toEqual({
      status: "failed",
      deliveryId: "delivery-1",
      channel: "slack",
      error: "transport blew up",
    });
    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({ status: "failed", last_error: "transport blew up" }),
    });
  });

  it("uses attempts+1 straight off the claimed row for an UNFENCED (primary-claim) row, not a fresh read", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({ channel: "bell", attempts: 2 });

    await deliverAppointmentReminder(supabase, row);

    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({ attempts: 3 }),
    });
  });

  it("reports (but does not throw on) a markDelivery update error", async () => {
    const supabase = fakeSupabase({ updateError: { message: "db unavailable" } });

    await deliverAppointmentReminder(supabase, baseRow({ channel: "bell" }));

    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "reminder_delivery_mark" } }),
    );
  });
});

describe("deliverAppointmentReminder — retry-claim fencing (Codex round 1)", () => {
  it("a retry-claimed row (claimToken present) writes attempts AS-IS (the claim already bumped it) and fences the write by id+claim_token+claimed_status", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({
      channel: "bell",
      attempts: 2,
      claimToken: "token-abc",
      claimedStatus: "failed",
    });

    await deliverAppointmentReminder(supabase, row);

    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({ status: "sent", attempts: 2 }),
      eqs: expect.arrayContaining([
        ["id", "delivery-1"],
        ["claim_token", "token-abc"],
        ["status", "failed"],
      ]),
    });
  });

  it("an unfenced (primary-claim) row's write carries no claim_token/status condition", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({ channel: "bell", claimToken: null, claimedStatus: null });

    await deliverAppointmentReminder(supabase, row);

    const eqColumns = supabase.updates[0].eqs.map(([col]: [string, unknown]) => col);
    expect(eqColumns).toEqual(["id"]);
  });

  it("a lost lease (0 rows matched by the fenced write) is abandoned silently — no reportError call", async () => {
    const supabase = fakeSupabase({ matchedRows: 0 });
    const row = baseRow({
      channel: "bell",
      attempts: 2,
      claimToken: "stale-token",
      claimedStatus: "failed",
    });

    const outcome = await deliverAppointmentReminder(supabase, row);

    // The delivery still reports its own outcome to the sweep loop's
    // tally — only the DB write was fenced away, not the provider call
    // (which already happened, e.g. an SMS may have gone out under the
    // reclaimed token's own attempt). Losing the lease means SOME other
    // claim now owns bookkeeping for this row.
    expect(outcome.status).toBe("sent");
    expect(mocks.reportError).not.toHaveBeenCalled();
  });
});
