import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  deliverAppointmentReminder,
  markReminderDeliveryTimedOut,
  resolveTimedOutReminderDelivery,
  type ClaimedReminderRow,
} from "./reminders";

function baseRow(overrides: Partial<ClaimedReminderRow> = {}): ClaimedReminderRow {
  return {
    deliveryId: "delivery-1",
    taskId: "task-1",
    orgId: "org-1",
    channel: "bell",
    attempts: 0,
    // Codex round 2: every claimed row now carries a token, minted by
    // fn_claim_appointment_reminders on the initial insert (this) or by
    // fn_claim_reminder_retries on a reclaim (attemptsAlreadyBumped: true
    // overrides below). "pending" is the initial-claim default status.
    attemptsAlreadyBumped: false,
    claimToken: "initial-token",
    claimedStatus: "pending",
    taskTitle: "Walkthrough with seller",
    taskDueAt: "2026-08-15T20:00:00.000Z",
    taskEndAt: "2026-08-15T20:30:00.000Z",
    assigneeId: "assignee-1",
    assigneeTimezone: "America/Chicago",
    assigneeReminderPhone: null,
    // Codex round 4: only ever non-null on a retry-claimed row whose prior
    // attempt already reached Slack/Sendillo. Default null matches every
    // pre-round-4 test's assumptions (provider always gets called).
    providerMessageId: null,
    ...overrides,
  };
}

/** Fake admin Supabase client: only
 *  `.from("task_reminder_deliveries").update(...).eq(...).select("id")` is
 *  exercised by the worker's markDelivery helper. `matchedRows` controls
 *  how many rows `.select("id")` reports as affected — 1 (default) for an
 *  ordinary successful write, 0 to simulate a fenced write losing the race
 *  (lease reclaimed by another sweep). */
/** One `.select("id")` resolution: `error` set simulates a write failure
 *  (Codex round 4's retry loop retries these); `matchedRows` (default 1)
 *  controls how many rows a successful write reports as affected. */
type UpdateResult = { error?: { message: string } | null; matchedRows?: number };

function fakeSupabase(
  opts: {
    updateError?: { message: string } | null;
    matchedRows?: number;
    /** Codex round 4: a QUEUE of per-call results, consumed in order —
     *  one entry per `.select("id")` call — for exercising the mark-
     *  delivery retry loop (e.g. two errors then a success). Falls back
     *  to the static `updateError`/`matchedRows` behavior (repeated on
     *  every call) when omitted, same as every pre-round-4 test. */
    updateResults?: UpdateResult[];
  } = {},
) {
  const staticResult: UpdateResult = {
    error: opts.updateError ?? null,
    matchedRows: opts.matchedRows ?? 1,
  };
  const resultQueue = opts.updateResults ? [...opts.updateResults] : null;
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
        select: vi.fn(async () => {
          const result =
            resultQueue && resultQueue.length > 0 ? resultQueue.shift()! : staticResult;
          const error = result.error ?? null;
          const matchedRows = result.matchedRows ?? 1;
          return {
            data: error ? null : Array.from({ length: matchedRows }, (_, i) => ({ id: `row-${i}` })),
            error,
          };
        }),
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

afterEach(() => {
  vi.useRealTimers();
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

  // Codex round 10 (finding 4): `not_sent` (the deadline signal was already
  // aborted before Sendillo's fetch was ever attempted) is PROVABLY
  // non-delivery, unlike `aborted_ambiguous` below — routes through the
  // ordinary retryable `failed` write, not the ambiguous-holding-state
  // fence.
  it("marks failed (ordinary, retryable) — not ambiguous — when sendRepSmsReminder reports not_sent", async () => {
    mocks.sendRepSmsReminder.mockResolvedValueOnce({
      ok: false,
      reason: "not_sent",
      message: "Sendillo send not attempted: deadline signal was already aborted",
    });
    const supabase = fakeSupabase();
    const row = baseRow({ channel: "sms" });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(outcome).toEqual({
      status: "failed",
      deliveryId: "delivery-1",
      channel: "sms",
      error: "Sendillo send not attempted: deadline signal was already aborted",
    });
    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({
        status: "failed",
        last_error: "Sendillo send not attempted: deadline signal was already aborted",
      }),
    });
  });

  // Codex round 8: a deadline AbortSignal firing mid-Sendillo-call cannot
  // prove non-delivery — it must NOT be handled as an ordinary
  // provider_error (which falls through to markDelivery-failed below and,
  // via the sweep's after() continuation replaying this same outcome
  // through resolveTimedOutReminderDelivery, would transition the row
  // timeout_ambiguous -> failed and make it retry-eligible despite
  // completion being genuinely unknown).
  //
  // Codex round 10 (finding 2): round 8 left this write to
  // `resolveTimedOutReminderDelivery` on the theory that only the sweep's
  // OWN deadline race ever produces `aborted_ambiguous`. But
  // `sendRepSmsReminder` can also resolve this reason because SENDILLO'S
  // OWN internal timeout won the race — settling BEFORE the sweep's
  // deadline fires, so `withDeliveryDeadline`'s timeout branch (and
  // `markReminderDeliveryTimedOut`) never runs at all. This is that direct
  // (non-timeout-race) path: `deliverAppointmentReminder` is called plainly
  // (no `signal`, mirroring a call that settles before any outer race), and
  // the row must still end up fenced into `timeout_ambiguous` — never left
  // sitting at its original claimed status where a retry claim could
  // reclaim it and risk a duplicate SMS on top of a send whose outcome is
  // genuinely unknown.
  it("fences claimedStatus -> timeout_ambiguous when sendRepSmsReminder reports aborted_ambiguous directly (Sendillo's own timeout won the race, not the sweep's)", async () => {
    mocks.sendRepSmsReminder.mockResolvedValueOnce({
      ok: false,
      reason: "aborted_ambiguous",
      message: "This operation was aborted",
    });
    const supabase = fakeSupabase();
    const row = baseRow({ channel: "sms" });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(outcome).toEqual({
      status: "aborted_ambiguous",
      deliveryId: "delivery-1",
      channel: "sms",
      lastError: "This operation was aborted",
    });
    expect(supabase.updates).toHaveLength(1);
    expect(supabase.updates[0]).toMatchObject({
      table: "task_reminder_deliveries",
      payload: expect.objectContaining({
        status: "timeout_ambiguous",
        last_error: "This operation was aborted",
      }),
      eqs: expect.arrayContaining([
        ["id", "delivery-1"],
        ["claim_token", "initial-token"],
        // Fenced off the row's ORIGINAL claimedStatus ("pending") — this is
        // the direct-race path, so the sweep's own deadline race never
        // touched the row first.
        ["status", "pending"],
      ]),
    });
  });

  it("a direct aborted_ambiguous write is a benign no-op when the sweep's own deadline race already fenced the row first (0 rows matched, not an error)", async () => {
    mocks.sendRepSmsReminder.mockResolvedValueOnce({
      ok: false,
      reason: "aborted_ambiguous",
      message: "This operation was aborted",
    });
    // 0 rows matched: simulates the row already having moved to
    // timeout_ambiguous via markReminderDeliveryTimedOut before this write
    // runs — this function's own fence write is scoped to the row's STALE
    // pre-claim `claimedStatus`, so it correctly matches nothing here.
    const supabase = fakeSupabase({ matchedRows: 0 });
    const row = baseRow({ channel: "sms" });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(outcome).toEqual({
      status: "aborted_ambiguous",
      deliveryId: "delivery-1",
      channel: "sms",
      lastError: "This operation was aborted",
    });
    expect(mocks.reportError).not.toHaveBeenCalled();
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

  it("uses attempts+1 straight off the claimed row for a fresh initial-claim row (attemptsAlreadyBumped: false), not a fresh read", async () => {
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
  it("a retry-claimed row (attemptsAlreadyBumped) writes attempts AS-IS (the claim already bumped it) and fences the write by id+claim_token+claimed_status", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({
      channel: "bell",
      attempts: 2,
      attemptsAlreadyBumped: true,
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

  it("a fresh initial-claim row (attemptsAlreadyBumped: false) is ALSO fenced by its own id+claim_token+claimed_status", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({
      channel: "bell",
      attempts: 0,
      attemptsAlreadyBumped: false,
      claimToken: "initial-token",
      claimedStatus: "pending",
    });

    await deliverAppointmentReminder(supabase, row);

    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({ status: "sent", attempts: 1 }),
      eqs: expect.arrayContaining([
        ["id", "delivery-1"],
        ["claim_token", "initial-token"],
        ["status", "pending"],
      ]),
    });
  });

  it("a lost lease (0 rows matched by the fenced write) is abandoned silently — no reportError call", async () => {
    const supabase = fakeSupabase({ matchedRows: 0 });
    const row = baseRow({
      channel: "bell",
      attempts: 2,
      attemptsAlreadyBumped: true,
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

  it("Codex round 2: a STALE-TOKEN INITIAL worker's sent/failed writes are no-ops (0 rows matched) — the retry claim already reclaimed this row out from under it", async () => {
    // Simulates: fn_claim_appointment_reminders claims the row (token A,
    // status pending), the initial provider call stalls past the
    // 2-minute lease, fn_claim_reminder_retries reclaims the SAME row
    // (fresh token B, still status pending) and starts its own delivery.
    // The stalled initial worker's eventual sent/failed write must be a
    // no-op, not a clobber of the retry owner's outcome.
    const supabase = fakeSupabase({ matchedRows: 0 });
    const staleInitialRow = baseRow({
      channel: "sms",
      attempts: 0,
      attemptsAlreadyBumped: false,
      claimToken: "token-A-stale",
      claimedStatus: "pending",
    });

    const sentOutcome = await deliverAppointmentReminder(supabase, staleInitialRow);
    expect(sentOutcome.status).toBe("sent");
    expect(supabase.updates[0]).toMatchObject({
      eqs: expect.arrayContaining([
        ["id", "delivery-1"],
        ["claim_token", "token-A-stale"],
        ["status", "pending"],
      ]),
    });
    expect(mocks.reportError).not.toHaveBeenCalled();

    mocks.sendRepSmsReminder.mockResolvedValueOnce({ ok: false, reason: "boom", message: "boom" });
    const failedOutcome = await deliverAppointmentReminder(supabase, staleInitialRow);
    expect(failedOutcome.status).toBe("failed");
    expect(supabase.updates[1]).toMatchObject({
      payload: expect.objectContaining({ status: "failed" }),
      eqs: expect.arrayContaining([
        ["id", "delivery-1"],
        ["claim_token", "token-A-stale"],
        ["status", "pending"],
      ]),
    });
    expect(mocks.reportError).not.toHaveBeenCalled();
  });
});

describe("Codex round 4 (finding 3): reconciliation-on-retry — provider already reached, don't re-send", () => {
  it("slack: a retry-claimed row that already carries providerMessageId reconciles (marks sent with that id) WITHOUT calling dispatchAppointmentReminderSlack again", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({
      channel: "slack",
      attemptsAlreadyBumped: true,
      claimToken: "retry-token",
      claimedStatus: "failed",
      providerMessageId: "1710000000.000999",
    });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(mocks.dispatchAppointmentReminderSlack).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "sent",
      deliveryId: "delivery-1",
      channel: "slack",
      providerMessageId: "1710000000.000999",
    });
    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({
        status: "sent",
        provider_message_id: "1710000000.000999",
      }),
    });
  });

  it("sms: a retry-claimed row that already carries providerMessageId reconciles (marks sent with that id) WITHOUT calling sendRepSmsReminder again", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({
      channel: "sms",
      attemptsAlreadyBumped: true,
      claimToken: "retry-token",
      claimedStatus: "failed",
      providerMessageId: "sms-ext-prior",
    });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(mocks.sendRepSmsReminder).not.toHaveBeenCalled();
    // The live prefs re-check is also skipped — reconciliation never
    // needs to send, so there's nothing to re-validate a phone number for.
    expect(mocks.loadIntegrationPrefs).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "sent",
      deliveryId: "delivery-1",
      channel: "sms",
      providerMessageId: "sms-ext-prior",
    });
    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({
        status: "sent",
        provider_message_id: "sms-ext-prior",
      }),
    });
  });

  it("bell rows never carry a providerMessageId and are unaffected — createNotification still runs normally", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({ channel: "bell", providerMessageId: null });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(mocks.createNotification).toHaveBeenCalled();
    expect(outcome.status).toBe("sent");
  });
});

describe("Codex round 4 (finding 3): bounded retry on the mark-sent write", () => {
  it("retries a transient write error and succeeds on a later attempt, without reporting any error", async () => {
    vi.useFakeTimers();
    const supabase = fakeSupabase({
      updateResults: [
        { error: { message: "db blip 1" } },
        { error: { message: "db blip 2" } },
        { error: null, matchedRows: 1 },
      ],
    });

    const outcomePromise = deliverAppointmentReminder(supabase, baseRow({ channel: "bell" }));
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("sent");
    // Three separate .update() calls — two failed, one succeeded — all
    // against the SAME delivery row.
    expect(supabase.updates).toHaveLength(3);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("exhausts all 3 attempts, reports the failure WITHOUT a duplicate-risk tag when marking 'failed' (no provider send occurred, so re-trying is simply correct)", async () => {
    vi.useFakeTimers();
    mocks.dispatchAppointmentReminderSlack.mockResolvedValueOnce({
      sent: false,
      reason: "pref_disabled",
    });
    const supabase = fakeSupabase({ updateError: { message: "db down" } });

    const outcomePromise = deliverAppointmentReminder(supabase, baseRow({ channel: "slack" }));
    await vi.runAllTimersAsync();
    await outcomePromise;

    expect(supabase.updates).toHaveLength(3);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    const [, context] = mocks.reportError.mock.calls[0];
    expect(context.tags).toEqual({ surface: "reminder_delivery_mark" });
    expect(context.tags.duplicate_risk).toBeUndefined();
  });

  it("exhausts all 3 attempts marking 'sent' with a providerMessageId — reports the failure WITH an explicit duplicate-risk tag, since the provider send already succeeded and the row is left retryable", async () => {
    vi.useFakeTimers();
    const supabase = fakeSupabase({ updateError: { message: "db down" } });

    const outcomePromise = deliverAppointmentReminder(supabase, baseRow({ channel: "slack" }));
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    // The delivery still reports its own "sent" outcome — the provider
    // call genuinely succeeded; only the bookkeeping write failed.
    expect(outcome.status).toBe("sent");
    expect(supabase.updates).toHaveLength(3);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { surface: "reminder_delivery_mark", duplicate_risk: true },
        extra: { deliveryId: "delivery-1", status: "sent" },
      }),
    );
  });

  it("does NOT retry a clean 0-rows 'lease lost' result — that's a legitimate outcome, not a write error", async () => {
    const supabase = fakeSupabase({ matchedRows: 0 });

    const outcome = await deliverAppointmentReminder(supabase, baseRow({ channel: "bell" }));

    expect(outcome.status).toBe("sent");
    expect(supabase.updates).toHaveLength(1);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });
});

describe("Codex round 7 (finding 1): timeout_ambiguous fencing", () => {
  it("markReminderDeliveryTimedOut fences claimed(original claimedStatus) -> timeout_ambiguous, not 'failed'", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({ claimToken: "tok-1", claimedStatus: "pending" });

    await markReminderDeliveryTimedOut(supabase, row);

    expect(supabase.updates).toHaveLength(1);
    const [update] = supabase.updates;
    expect(update.payload).toMatchObject({
      status: "timeout_ambiguous",
      last_error: "delivery timeout, completion ambiguous",
    });
    // Fenced by the row's ORIGINAL pre-claim status — this is the FIRST
    // transition, off whatever the claim RPC handed the worker.
    expect(update.eqs).toContainEqual(["claim_token", "tok-1"]);
    expect(update.eqs).toContainEqual(["status", "pending"]);
  });

  it("resolveTimedOutReminderDelivery (late success) fences timeout_ambiguous -> sent with the real provider id, NOT off the row's original claimedStatus", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({ claimToken: "tok-1", claimedStatus: "failed" });

    await resolveTimedOutReminderDelivery(supabase, row, {
      status: "sent",
      deliveryId: row.deliveryId,
      channel: "sms",
      providerMessageId: "snd_late_1",
    });

    expect(supabase.updates).toHaveLength(1);
    const [update] = supabase.updates;
    expect(update.payload).toMatchObject({
      status: "sent",
      provider_message_id: "snd_late_1",
    });
    // Fenced against timeout_ambiguous — the status the deadline race left
    // the row in — NOT the row's stale original claimedStatus ("failed"
    // here). A write scoped by the original status would silently no-op
    // (0 rows matched) instead of persisting the real outcome.
    expect(update.eqs).toContainEqual(["claim_token", "tok-1"]);
    expect(update.eqs).toContainEqual(["status", "timeout_ambiguous"]);
    expect(update.eqs).not.toContainEqual(["status", "failed"]);
  });

  it("resolveTimedOutReminderDelivery (late definite failure) fences timeout_ambiguous -> failed — now safely retryable", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({ claimToken: "tok-1", claimedStatus: "pending" });

    await resolveTimedOutReminderDelivery(supabase, row, {
      status: "failed",
      deliveryId: row.deliveryId,
      channel: "sms",
      error: "provider rejected",
    });

    expect(supabase.updates).toHaveLength(1);
    const [update] = supabase.updates;
    expect(update.payload).toMatchObject({ status: "failed", last_error: "provider rejected" });
    expect(update.eqs).toContainEqual(["status", "timeout_ambiguous"]);
  });

  it("resolveTimedOutReminderDelivery (aborted_ambiguous) LEAVES the row in timeout_ambiguous — records last_error, never transitions to failed", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({ claimToken: "tok-1", claimedStatus: "pending" });

    await resolveTimedOutReminderDelivery(supabase, row, {
      status: "aborted_ambiguous",
      deliveryId: row.deliveryId,
      channel: "sms",
      lastError: "This operation was aborted",
    });

    expect(supabase.updates).toHaveLength(1);
    const [update] = supabase.updates;
    // Same status in, same status out — a genuine abort proves nothing
    // about delivery, so this is a same-status write (updated last_error
    // only), NEVER a transition to "failed" (which would make the row
    // retry-eligible and risk a duplicate SMS on top of a send that may
    // have already reached Sendillo).
    expect(update.payload).toMatchObject({
      status: "timeout_ambiguous",
      last_error: "aborted; delivery ambiguous",
    });
    expect(update.eqs).toContainEqual(["claim_token", "tok-1"]);
    expect(update.eqs).toContainEqual(["status", "timeout_ambiguous"]);
    expect(update.eqs).not.toContainEqual(["status", "failed"]);
  });

  it("resolveTimedOutReminderDelivery (genuine late 4xx/5xx after timeout) STILL transitions timeout_ambiguous -> failed — retryable, unlike an abort", async () => {
    const supabase = fakeSupabase();
    const row = baseRow({ claimToken: "tok-1", claimedStatus: "pending" });

    await resolveTimedOutReminderDelivery(supabase, row, {
      status: "failed",
      deliveryId: row.deliveryId,
      channel: "sms",
      error: "Sendillo 422: invalid recipient",
    });

    expect(supabase.updates).toHaveLength(1);
    const [update] = supabase.updates;
    expect(update.payload).toMatchObject({
      status: "failed",
      last_error: "Sendillo 422: invalid recipient",
    });
    expect(update.eqs).toContainEqual(["status", "timeout_ambiguous"]);
  });

  it("a lost fence (row reclaimed/resolved out from under the continuation) is a silent no-op, same posture as every other markDelivery write", async () => {
    const supabase = fakeSupabase({ matchedRows: 0 });
    const row = baseRow({ claimToken: "tok-1", claimedStatus: "pending" });

    await resolveTimedOutReminderDelivery(supabase, row, {
      status: "sent",
      deliveryId: row.deliveryId,
      channel: "sms",
      providerMessageId: "snd_late_1",
    });

    expect(supabase.updates).toHaveLength(1);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });
});
