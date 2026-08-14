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
  // Codex round 11 (finding 2): real linkage-routing logic (not a stub) so
  // the "route.ts" deep-link tests below actually exercise the same
  // property/contact/personal-block branching production uses.
  buildAppointmentDeepLink: (propertyId?: string | null, contactId?: string | null) => {
    if (propertyId) return `https://sandra-sooty.vercel.app/leads/${propertyId}`;
    if (contactId) return `https://sandra-sooty.vercel.app/messages?thread=${contactId}`;
    return "https://sandra-sooty.vercel.app/dashboard";
  },
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
    // Codex round 11 (finding 2): defaults to a personal block (neither
    // linkage) — individual tests override to exercise the other two.
    relatedPropertyId: null,
    contactId: null,
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
    outcome: "sent",
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
  it("fences claimed -> dispatching BEFORE calling dispatchAppointmentReminderSlack, then dispatching -> sent with the messageTs on success", async () => {
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
        // Personal block (no property/contact linkage on baseRow's
        // default) -> /dashboard, not the dead /tasks/<id> route.
        deepLink: "https://sandra-sooty.vercel.app/dashboard",
      }),
    );
    expect(outcome).toEqual({
      status: "sent",
      deliveryId: "delivery-1",
      channel: "slack",
      providerMessageId: "1710000000.000100",
    });
    // Codex round 12 (finding 2): the dispatching fence lands FIRST — the
    // real closer of the crash-between-accept-and-write hole — fenced by
    // the row's original claimed status.
    expect(supabase.updates).toHaveLength(2);
    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({ status: "dispatching", attempts: 1 }),
      eqs: expect.arrayContaining([
        ["id", "delivery-1"],
        ["claim_token", "initial-token"],
        ["status", "pending"],
      ]),
    });
    // The outcome write fences off 'dispatching', not the row's original
    // claimed status — that's the whole point of the fence.
    expect(supabase.updates[1]).toMatchObject({
      payload: expect.objectContaining({
        status: "sent",
        provider_message_id: "1710000000.000100",
        attempts: 1,
      }),
      eqs: expect.arrayContaining([
        ["id", "delivery-1"],
        ["claim_token", "initial-token"],
        ["status", "dispatching"],
      ]),
    });
  });

  // Codex round 11 (finding 2): route-level coverage of the Slack CTA's
  // linkage-aware deep link across all three linkages the claim RPC can
  // hand back (property, contact-only, personal block/neither).
  describe("CTA deep link (Codex round 11, finding 2)", () => {
    it("property-linked -> /leads/<propertyId>", async () => {
      const supabase = fakeSupabase();
      const row = baseRow({ channel: "slack", relatedPropertyId: "prop-1", contactId: null });

      await deliverAppointmentReminder(supabase, row);

      expect(mocks.dispatchAppointmentReminderSlack).toHaveBeenCalledWith(
        expect.objectContaining({ deepLink: "https://sandra-sooty.vercel.app/leads/prop-1" }),
      );
    });

    it("contact-only -> /messages?thread=<contactId>", async () => {
      const supabase = fakeSupabase();
      const row = baseRow({ channel: "slack", relatedPropertyId: null, contactId: "contact-1" });

      await deliverAppointmentReminder(supabase, row);

      expect(mocks.dispatchAppointmentReminderSlack).toHaveBeenCalledWith(
        expect.objectContaining({
          deepLink: "https://sandra-sooty.vercel.app/messages?thread=contact-1",
        }),
      );
    });

    it("personal block (neither linkage) -> /dashboard", async () => {
      const supabase = fakeSupabase();
      const row = baseRow({ channel: "slack", relatedPropertyId: null, contactId: null });

      await deliverAppointmentReminder(supabase, row);

      expect(mocks.dispatchAppointmentReminderSlack).toHaveBeenCalledWith(
        expect.objectContaining({ deepLink: "https://sandra-sooty.vercel.app/dashboard" }),
      );
    });
  });

  it("marks failed with the reason when Slack dispatch reports a definite pre-send failure", async () => {
    mocks.dispatchAppointmentReminderSlack.mockResolvedValueOnce({
      outcome: "failed",
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
    expect(supabase.updates).toHaveLength(2);
    expect(supabase.updates[1]).toMatchObject({
      payload: expect.objectContaining({ status: "failed", last_error: "pref_disabled" }),
      eqs: expect.arrayContaining([["status", "dispatching"]]),
    });
  });

  // Codex round 12 (finding 1): dispatch.ts now returns a three-way
  // outcome — transmission-started-but-unproven must fence into
  // timeout_ambiguous, never the ordinary retryable `failed`.
  it("fences dispatching -> timeout_ambiguous (aborted_ambiguous outcome) when Slack dispatch reports ambiguous — a postMessage exception or accepted-without-ts", async () => {
    mocks.dispatchAppointmentReminderSlack.mockResolvedValueOnce({
      outcome: "ambiguous",
      reason: "Slack chat.postMessage resolved without a ts",
    });
    const supabase = fakeSupabase();

    const outcome = await deliverAppointmentReminder(supabase, baseRow({ channel: "slack" }));

    expect(outcome).toEqual({
      status: "aborted_ambiguous",
      deliveryId: "delivery-1",
      channel: "slack",
      lastError: "Slack chat.postMessage resolved without a ts",
    });
    expect(supabase.updates).toHaveLength(2);
    expect(supabase.updates[1]).toMatchObject({
      payload: expect.objectContaining({
        status: "timeout_ambiguous",
        last_error: "Slack chat.postMessage resolved without a ts",
      }),
      eqs: expect.arrayContaining([["status", "dispatching"]]),
    });
  });

  // Codex round 12 (finding 2): the row's lease was ALREADY lost before any
  // provider call was ever attempted — the dispatching fence itself is a
  // 0-row no-op. dispatchAppointmentReminderSlack must never be called in
  // this case (no send should be attempted for a row this worker no longer
  // owns).
  it("reports lease_lost and never calls dispatchAppointmentReminderSlack when the pre-dispatch fence itself loses the lease", async () => {
    const supabase = fakeSupabase({ matchedRows: 0 });

    const outcome = await deliverAppointmentReminder(supabase, baseRow({ channel: "slack" }));

    expect(outcome).toEqual({ status: "lease_lost", deliveryId: "delivery-1", channel: "slack" });
    expect(mocks.dispatchAppointmentReminderSlack).not.toHaveBeenCalled();
    expect(supabase.updates).toHaveLength(1);
    expect(mocks.reportError).not.toHaveBeenCalled();
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
    // Codex round 12 (finding 2): the dispatching fence write lands first —
    // updates[1] is the outcome write, fenced off 'dispatching'.
    expect(supabase.updates).toHaveLength(2);
    expect(supabase.updates[1]).toMatchObject({
      payload: expect.objectContaining({
        status: "failed",
        last_error: "Sendillo send not attempted: deadline signal was already aborted",
      }),
      eqs: expect.arrayContaining([["status", "dispatching"]]),
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
  it("fences dispatching -> timeout_ambiguous when sendRepSmsReminder reports aborted_ambiguous directly (Sendillo's own timeout won the race, not the sweep's)", async () => {
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
    // Codex round 12 (finding 2): the dispatching fence (fenced off the
    // row's ORIGINAL claimed status) lands first; the aborted_ambiguous
    // fence lands second, off 'dispatching' — not the stale original
    // status the pre-round-12 version of this test asserted.
    expect(supabase.updates).toHaveLength(2);
    expect(supabase.updates[0]).toMatchObject({
      payload: expect.objectContaining({ status: "dispatching" }),
      eqs: expect.arrayContaining([
        ["id", "delivery-1"],
        ["claim_token", "initial-token"],
        ["status", "pending"],
      ]),
    });
    expect(supabase.updates[1]).toMatchObject({
      table: "task_reminder_deliveries",
      payload: expect.objectContaining({
        status: "timeout_ambiguous",
        last_error: "This operation was aborted",
      }),
      eqs: expect.arrayContaining([
        ["id", "delivery-1"],
        ["claim_token", "initial-token"],
        ["status", "dispatching"],
      ]),
    });
  });

  it("a direct aborted_ambiguous write is a benign no-op when a concurrent claim already moved the row off 'dispatching' (0 rows matched, not an error)", async () => {
    mocks.sendRepSmsReminder.mockResolvedValueOnce({
      ok: false,
      reason: "aborted_ambiguous",
      message: "This operation was aborted",
    });
    // The dispatching fence itself succeeds (1st write); the SECOND write
    // (the aborted_ambiguous fence, scoped to 'dispatching') matches 0 rows
    // — simulating some other process having already moved the row off
    // 'dispatching' in between (e.g. the stale-dispatching sweep, or a
    // second continuation).
    const supabase = fakeSupabase({
      updateResults: [{ error: null, matchedRows: 1 }, { error: null, matchedRows: 0 }],
    });
    const row = baseRow({ channel: "sms" });

    const outcome = await deliverAppointmentReminder(supabase, row);

    expect(outcome).toEqual({
      status: "aborted_ambiguous",
      deliveryId: "delivery-1",
      channel: "sms",
      lastError: "This operation was aborted",
    });
    expect(supabase.updates).toHaveLength(2);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  // Codex round 12 (finding 2): the row's lease was ALREADY lost before any
  // provider call was ever attempted — the pre-dispatch fence itself is a
  // 0-row no-op, and sendRepSmsReminder must never be called for a row this
  // worker no longer owns.
  it("reports lease_lost and never calls sendRepSmsReminder when the pre-dispatch fence itself loses the lease", async () => {
    const supabase = fakeSupabase({ matchedRows: 0 });

    const outcome = await deliverAppointmentReminder(supabase, baseRow({ channel: "sms" }));

    expect(outcome).toEqual({ status: "lease_lost", deliveryId: "delivery-1", channel: "sms" });
    expect(mocks.sendRepSmsReminder).not.toHaveBeenCalled();
    expect(supabase.updates).toHaveLength(1);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });
});

describe("deliverAppointmentReminder — defense in depth", () => {
  it("never throws: an unexpected exception from a channel's provider call is caught, delivery marked failed", async () => {
    // Codex round 12 (finding 2): bell, not slack — slack/sms now fence
    // into 'dispatching' before their provider call, so an exception from
    // deep inside them can land AFTER that fence, and this top-level catch
    // (which only has the row's ORIGINAL claimed status to fence with)
    // would then benignly no-op against the real 'dispatching' status
    // instead of landing a "failed" write — exactly the same "lease
    // reassigned" ambiguity this whole round exists to make safe, not a
    // regression. Bell has no such fence, so it isolates this generic
    // top-level-catch behavior cleanly.
    mocks.createNotification.mockRejectedValueOnce(new Error("transport blew up"));
    const supabase = fakeSupabase();

    const outcome = await deliverAppointmentReminder(supabase, baseRow({ channel: "bell" }));

    expect(outcome).toEqual({
      status: "failed",
      deliveryId: "delivery-1",
      channel: "bell",
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

  // Codex round 12 (finding 3): pre-round-12 this asserted `outcome.status
  // === "sent"` — a fenced write matching ZERO rows was silently reported
  // as a confirmed send. That's the bug: no row landed, so nothing was
  // actually confirmed by THIS worker. `lease_lost` is now its own honest
  // outcome, distinct from `sent`.
  it("a lost lease (0 rows matched by the fenced write) is reported as lease_lost, not sent — no reportError call", async () => {
    const supabase = fakeSupabase({ matchedRows: 0 });
    const row = baseRow({
      channel: "bell",
      attempts: 2,
      attemptsAlreadyBumped: true,
      claimToken: "stale-token",
      claimedStatus: "failed",
    });

    const outcome = await deliverAppointmentReminder(supabase, row);

    // A different owner now holds this row's lease — its own delivery
    // attempt (or lack thereof) is authoritative, not this worker's.
    expect(outcome).toEqual({ status: "lease_lost", deliveryId: "delivery-1", channel: "bell" });
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  // Codex round 2, extended round 12 (findings 2/3): simulates
  // fn_claim_appointment_reminders claiming the row (token A, status
  // pending), then fn_claim_reminder_retries reclaiming the SAME row
  // (fresh token) before this stale worker gets anywhere. Pre-round-12,
  // the stale worker would still call the provider and only discover the
  // lost lease at the FINAL write; the round-12 pre-dispatch fence now
  // catches this at the FIRST write, before any provider call — a strict
  // improvement (no risk of a duplicate send from a worker that has
  // already lost its lease), and correctly reports `lease_lost`, not
  // `sent` (round 3's fix to markSentOrRepair).
  it("Codex round 2/12: a STALE-TOKEN INITIAL worker's pre-dispatch fence is a no-op (0 rows matched) — the retry claim already reclaimed this row, and no provider call is ever attempted", async () => {
    const supabase = fakeSupabase({ matchedRows: 0 });
    const staleInitialRow = baseRow({
      channel: "sms",
      attempts: 0,
      attemptsAlreadyBumped: false,
      claimToken: "token-A-stale",
      claimedStatus: "pending",
    });

    const outcome = await deliverAppointmentReminder(supabase, staleInitialRow);

    expect(outcome).toEqual({ status: "lease_lost", deliveryId: "delivery-1", channel: "sms" });
    expect(mocks.sendRepSmsReminder).not.toHaveBeenCalled();
    expect(supabase.updates[0]).toMatchObject({
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
      outcome: "failed",
      reason: "pref_disabled",
    });
    // Codex round 12 (finding 2): the pre-dispatch fence write (1st call)
    // succeeds — it's the SUBSEQUENT failed-write attempts that hit the
    // chronic DB outage.
    const supabase = fakeSupabase({
      updateResults: [{ error: null, matchedRows: 1 }],
      updateError: { message: "db down" },
    });

    const outcomePromise = deliverAppointmentReminder(supabase, baseRow({ channel: "slack" }));
    await vi.runAllTimersAsync();
    await outcomePromise;

    // 1 dispatching fence + 3 failed mark-delivery attempts.
    expect(supabase.updates).toHaveLength(4);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    const [, context] = mocks.reportError.mock.calls[0];
    expect(context.tags).toEqual({ surface: "reminder_delivery_mark" });
    expect(context.tags.duplicate_risk).toBeUndefined();
  });

  // Codex round 11 (finding 1): replaces the pre-round-11 version of this
  // test, which accepted `outcome.status === "sent"` with the row left at
  // its ORIGINAL retryable status after every mark-sent write attempt
  // failed — a real duplicate-send bug (a future retry claim would
  // re-send on top of a provider call that already succeeded). The row
  // must now be forced into the non-resend repair state (`timeout_ambiguous`,
  // reused — see the migration's status-CHECK comment) instead, via a 4th
  // write this round adds (`repairIntoNonResendState`).
  it("exhausts all 3 mark-sent attempts, then forces the row into the non-resend repair state (timeout_ambiguous) instead of leaving it retryable — reports the original failure WITH the duplicate-risk tag", async () => {
    vi.useFakeTimers();
    const supabase = fakeSupabase({
      updateResults: [
        // Codex round 12 (finding 2): 1st write is the pre-dispatch fence
        // (claimed -> dispatching) — succeeds, so the send is actually
        // attempted.
        { error: null, matchedRows: 1 },
        { error: { message: "db down" } },
        { error: { message: "db down" } },
        { error: { message: "db down" } },
        // 5th write: repairIntoNonResendState's fenced repair attempt —
        // succeeds here.
        { error: null, matchedRows: 1 },
      ],
    });

    const outcomePromise = deliverAppointmentReminder(supabase, baseRow({ channel: "slack" }));
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    // NOT "sent" — the write that would confirm it never landed. The row
    // is reported as the same non-resend holding state the DB row now
    // actually carries.
    expect(outcome).toEqual({
      status: "timeout_ambiguous",
      deliveryId: "delivery-1",
      channel: "slack",
    });
    expect(supabase.updates).toHaveLength(5);
    expect(supabase.updates[4]).toMatchObject({
      payload: expect.objectContaining({ status: "timeout_ambiguous" }),
      eqs: expect.arrayContaining([
        ["id", "delivery-1"],
        ["claim_token", "initial-token"],
        // Fenced off 'dispatching' — the row's real pre-repair status,
        // not the stale original claimedStatus.
        ["status", "dispatching"],
      ]),
    });
    // markDelivery's own internal reportError (duplicate-risk tag) still
    // fires exactly once — the repair write succeeding adds no additional
    // report (repairIntoNonResendState only escalates loudly when the
    // REPAIR itself also fails).
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { surface: "reminder_delivery_mark", duplicate_risk: true },
        extra: { deliveryId: "delivery-1", status: "sent" },
      }),
    );
  });

  // Codex round 11 (finding 1): the worst case — even the repair write
  // can't land. The row is left retryable (nothing this worker can do
  // about that), but this MUST be escalated loudly — it's the one
  // scenario where a real duplicate send is genuinely possible.
  it("reports a SECOND, more severe error when the repair write into the non-resend state ALSO fails on both fenced and unfenced attempts", async () => {
    vi.useFakeTimers();
    // Codex round 12 (finding 2): pre-dispatch fence (1st write) succeeds;
    // everything after it hits the chronic DB outage.
    const supabase = fakeSupabase({
      updateResults: [{ error: null, matchedRows: 1 }],
      updateError: { message: "db down" },
    });

    const outcomePromise = deliverAppointmentReminder(supabase, baseRow({ channel: "slack" }));
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("timeout_ambiguous");
    // 1 dispatching fence + 3 mark-sent attempts + fenced repair attempt +
    // unfenced repair attempt = 6 total writes, every one after the first
    // erroring.
    expect(supabase.updates).toHaveLength(6);
    expect(mocks.reportError).toHaveBeenCalledTimes(2);
    expect(mocks.reportError).toHaveBeenLastCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: {
          surface: "reminder_delivery_mark",
          duplicate_risk: true,
          repair_failed: true,
        },
        extra: { deliveryId: "delivery-1" },
      }),
    );
  });

  it("does NOT retry a clean 0-rows 'lease lost' result — that's a legitimate outcome, not a write error", async () => {
    const supabase = fakeSupabase({ matchedRows: 0 });

    const outcome = await deliverAppointmentReminder(supabase, baseRow({ channel: "bell" }));

    // Codex round 12 (finding 3): a 0-row match is `lease_lost`, not `sent`.
    expect(outcome).toEqual({ status: "lease_lost", deliveryId: "delivery-1", channel: "bell" });
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

  // Codex round 11 (finding 1): "a failed ambiguous fence while a request
  // is unresolved" — if THIS write can't land after retries, the row is
  // left at its original pending/failed status while the provider call is
  // genuinely still in flight, retry-claim eligible on top of a delivery
  // whose outcome is truly unknown. Must force the same repair path.
  it("markReminderDeliveryTimedOut forces the row into the repair state via an unfenced fallback when its own fence write exhausts retries", async () => {
    vi.useFakeTimers();
    const supabase = fakeSupabase({
      updateResults: [
        { error: { message: "db down" } },
        { error: { message: "db down" } },
        { error: { message: "db down" } },
        // Fenced repair attempt fails too...
        { error: { message: "db still down" } },
        // ...unfenced fallback succeeds.
        { error: null, matchedRows: 1 },
      ],
    });
    const row = baseRow({ claimToken: "tok-1", claimedStatus: "pending" });

    const p = markReminderDeliveryTimedOut(supabase, row);
    await vi.runAllTimersAsync();
    await p;

    expect(supabase.updates).toHaveLength(5);
    // The unfenced fallback (5th write) has no claim_token/status
    // predicates — id only.
    const unfenced = supabase.updates[4];
    expect(unfenced.payload).toMatchObject({ status: "timeout_ambiguous" });
    expect(unfenced.eqs).toEqual([["id", "delivery-1"]]);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: {
          surface: "reminder_delivery_mark",
          duplicate_risk: true,
          repair_unfenced: true,
        },
      }),
    );
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
