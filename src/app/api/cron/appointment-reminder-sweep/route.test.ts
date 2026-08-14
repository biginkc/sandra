import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliverAppointmentReminder: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/notifications/reminders", () => ({
  deliverAppointmentReminder: mocks.deliverAppointmentReminder,
}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import { runAppointmentReminderSweep } from "./route";

type RawRow = {
  delivery_id: string;
  task_id: string;
  org_id: string;
  channel: "bell" | "slack" | "sms";
  attempts: number;
  claim_token: string;
  claimed_status: "pending" | "failed";
  task_title: string;
  task_due_at: string;
  task_end_at: string | null;
  assignee_id: string;
  assignee_timezone: string;
  assignee_reminder_phone: string | null;
};

// Codex round 2 fix: fn_claim_appointment_reminders now mints a
// claim_token + lease on every row it returns (same as
// fn_claim_reminder_retries always has) — a raw row from either RPC always
// carries one, so the default here isn't a "retry-only" value anymore.
function rawRow(id: string, overrides: Partial<RawRow> = {}): RawRow {
  return {
    delivery_id: id,
    task_id: `task-${id}`,
    org_id: "org-1",
    channel: "bell",
    attempts: 0,
    claim_token: `token-${id}`,
    claimed_status: "pending",
    task_title: "Walkthrough",
    task_due_at: "2026-09-01T15:00:00.000Z",
    task_end_at: "2026-09-01T15:30:00.000Z",
    assignee_id: "assignee-1",
    assignee_timezone: "America/Chicago",
    assignee_reminder_phone: null,
    ...overrides,
  };
}

/**
 * Fake Supabase client: `rpc` special-cases the two claim functions.
 *
 * Codex round 3 (finding 1): the primary claim is now one appointment at
 * a time (`p_limit: 1`), so `primaryBatches` is a queue of BATCHES — each
 * entry is the one-to-three delivery rows (bell/slack/sms) one claimed
 * appointment produces — and `rpc("fn_claim_appointment_reminders", ...)`
 * shifts one batch per call, same idiom as calendar-mutation-sweep's
 * route.test.ts one-row-per-call queue.
 */
function fakeSupabase(primaryBatches: RawRow[][], retried: RawRow[] = []) {
  const queue = [...primaryBatches];
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "fn_claim_appointment_reminders") {
      const batch = queue.shift();
      return { data: batch ?? [], error: null };
    }
    if (fn === "fn_claim_reminder_retries") {
      return { data: retried, error: null };
    }
    return { data: [], error: null };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { rpc } as any;
}

/** Calls to `rpc("fn_claim_appointment_reminders", ...)` only. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function primaryClaimCalls(supabase: any) {
  return supabase.rpc.mock.calls.filter(
    (call: unknown[]) => call[0] === "fn_claim_appointment_reminders",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAppointmentReminderSweep", () => {
  it("claims appointments one at a time (p_limit: 1), delivers every channel row of each, then claims retries", async () => {
    const supabase = fakeSupabase([[rawRow("a")], [rawRow("b")]], [rawRow("c")]);
    mocks.deliverAppointmentReminder.mockResolvedValue({
      status: "sent",
      deliveryId: "x",
      channel: "bell",
    });

    const summary = await runAppointmentReminderSweep(supabase, { budgetMs: 60_000 });

    for (const call of primaryClaimCalls(supabase)) {
      expect(call[1]).toEqual({ p_limit: 1 });
    }
    // Two successful claims (a, b) plus the third call that comes back
    // empty and ends the primary loop.
    expect(primaryClaimCalls(supabase)).toHaveLength(3);
    expect(supabase.rpc).toHaveBeenCalledWith("fn_claim_reminder_retries", { p_limit: 50 });
    expect(mocks.deliverAppointmentReminder).toHaveBeenCalledTimes(3);
    expect(summary.claimed).toBe(2);
    expect(summary.retried).toBe(1);
    expect(summary.processed).toBe(3);
  });

  it("Codex round 3 (finding 1): budget exhaustion between claim calls leaves the next appointment UNCLAIMED, not pending — no claim call is made for it", async () => {
    // startedAt read once; the budget check runs before every claim call.
    // Sequence: 0 (startedAt), 0 (check before claim #1 — proceeds),
    // budgetMs+1 (check before delivering claim #1's row — still
    // processes it, since the check inside the row loop runs after this
    // read too)... to keep this deterministic, drive it so exactly one
    // appointment is claimed+delivered and the second claim call never
    // happens.
    const budgetMs = 1_000;
    const times = [0, 0, 0, budgetMs + 1];
    let call = 0;
    vi.spyOn(Date, "now").mockImplementation(
      () => times[Math.min(call++, times.length - 1)],
    );

    const supabase = fakeSupabase([[rawRow("a")], [rawRow("b")]]);
    mocks.deliverAppointmentReminder.mockResolvedValue({
      status: "sent",
      deliveryId: "a",
      channel: "bell",
    });

    const summary = await runAppointmentReminderSweep(supabase, { budgetMs });

    expect(primaryClaimCalls(supabase)).toHaveLength(1);
    expect(mocks.deliverAppointmentReminder).toHaveBeenCalledTimes(1);
    expect(summary.claimed).toBe(1);
    expect(summary.processed).toBe(1);
    expect(summary.budgetExhausted).toBe(true);
    // Retry claim is skipped entirely once the primary loop exhausts the
    // budget — nothing left to spend on it this sweep.
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "fn_claim_reminder_retries",
      expect.anything(),
    );
  });

  it("stops claiming when the primary RPC returns nothing due, without treating it as budget exhaustion", async () => {
    const supabase = fakeSupabase([]);

    const summary = await runAppointmentReminderSweep(supabase, { budgetMs: 60_000 });

    expect(primaryClaimCalls(supabase)).toHaveLength(1);
    expect(mocks.deliverAppointmentReminder).not.toHaveBeenCalled();
    expect(summary.claimed).toBe(0);
    expect(summary.budgetExhausted).toBe(false);
  });

  it("caps appointments claimed per sweep at primaryClaimLimit", async () => {
    const supabase = fakeSupabase([[rawRow("a")], [rawRow("b")], [rawRow("c")]]);
    mocks.deliverAppointmentReminder.mockResolvedValue({
      status: "sent",
      deliveryId: "a",
      channel: "bell",
    });

    const summary = await runAppointmentReminderSweep(supabase, {
      budgetMs: 60_000,
      primaryClaimLimit: 2,
    });

    expect(primaryClaimCalls(supabase)).toHaveLength(2);
    expect(summary.claimed).toBe(2);
  });

  it("maps the raw RPC row shape to the worker's camelCase row before delivering", async () => {
    const supabase = fakeSupabase([
      [rawRow("a", { assignee_reminder_phone: "+18165551234", channel: "sms" })],
    ]);
    mocks.deliverAppointmentReminder.mockResolvedValue({
      status: "sent",
      deliveryId: "a",
      channel: "sms",
    });

    await runAppointmentReminderSweep(supabase, { budgetMs: 60_000 });

    expect(mocks.deliverAppointmentReminder).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        deliveryId: "a",
        taskId: "task-a",
        orgId: "org-1",
        channel: "sms",
        assigneeReminderPhone: "+18165551234",
      }),
    );
  });

  it("maps claim_token/claimed_status from both claim RPCs (Codex round 2: the primary claim now leases/tokens too), and tags attemptsAlreadyBumped by source", async () => {
    const supabase = fakeSupabase(
      [[rawRow("a", { claim_token: "token-a", claimed_status: "pending" })]],
      [rawRow("b", { claim_token: "token-123", claimed_status: "failed", attempts: 2 })],
    );
    mocks.deliverAppointmentReminder.mockResolvedValue({
      status: "sent",
      deliveryId: "x",
      channel: "bell",
    });

    await runAppointmentReminderSweep(supabase, { budgetMs: 60_000 });

    // Primary-claimed row: carries its own token/status, but the claim
    // never touched attempts — the worker must still write attempts + 1.
    expect(mocks.deliverAppointmentReminder).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        deliveryId: "a",
        claimToken: "token-a",
        claimedStatus: "pending",
        attemptsAlreadyBumped: false,
      }),
    );
    // Retry-claimed row: the claim already bumped attempts.
    expect(mocks.deliverAppointmentReminder).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        deliveryId: "b",
        claimToken: "token-123",
        claimedStatus: "failed",
        attempts: 2,
        attemptsAlreadyBumped: true,
      }),
    );
  });

  it("tallies outcomes by status and reports failed deliveries", async () => {
    const supabase = fakeSupabase([[rawRow("a")], [rawRow("b")]]);
    mocks.deliverAppointmentReminder
      .mockResolvedValueOnce({ status: "sent", deliveryId: "a", channel: "bell" })
      .mockResolvedValueOnce({ status: "failed", deliveryId: "b", channel: "bell", error: "boom" });

    const summary = await runAppointmentReminderSweep(supabase, { budgetMs: 60_000 });

    expect(summary.outcomes.sent).toBe(1);
    expect(summary.outcomes.failed).toBe(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "cron_appointment_reminder_sweep_outcome" } }),
    );
  });

  it("a rejecting delivery doesn't prevent the next row from being processed", async () => {
    const supabase = fakeSupabase([[rawRow("a")], [rawRow("b")]]);
    mocks.deliverAppointmentReminder
      .mockRejectedValueOnce(new Error("transport blew up"))
      .mockResolvedValueOnce({ status: "sent", deliveryId: "b", channel: "bell" });

    const summary = await runAppointmentReminderSweep(supabase, { budgetMs: 60_000 });

    expect(summary.processed).toBe(2);
    expect(summary.outcomes.sweep_level_error).toBe(1);
    expect(summary.outcomes.sent).toBe(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "cron_appointment_reminder_sweep_unhandled" } }),
    );
  });

  it("throws if the primary claim RPC errors", async () => {
    const supabase = fakeSupabase([]);
    supabase.rpc = vi.fn(async (fn: string) =>
      fn === "fn_claim_appointment_reminders"
        ? { data: null, error: { message: "boom" } }
        : { data: [], error: null },
    );

    await expect(runAppointmentReminderSweep(supabase, { budgetMs: 60_000 })).rejects.toThrow(
      /fn_claim_appointment_reminders failed/,
    );
    expect(mocks.deliverAppointmentReminder).not.toHaveBeenCalled();
  });

  it("throws if the retry claim RPC errors", async () => {
    const supabase = fakeSupabase([]);
    supabase.rpc = vi.fn(async (fn: string) =>
      fn === "fn_claim_reminder_retries"
        ? { data: null, error: { message: "boom" } }
        : { data: [], error: null },
    );

    await expect(runAppointmentReminderSweep(supabase, { budgetMs: 60_000 })).rejects.toThrow(
      /fn_claim_reminder_retries failed/,
    );
  });

  it("returns zeros and does not call the delivery worker when nothing is claimed", async () => {
    const supabase = fakeSupabase([]);

    const summary = await runAppointmentReminderSweep(supabase, { budgetMs: 60_000 });

    expect(summary.claimed).toBe(0);
    expect(summary.retried).toBe(0);
    expect(summary.processed).toBe(0);
    expect(mocks.deliverAppointmentReminder).not.toHaveBeenCalled();
  });
});
