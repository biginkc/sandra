import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliverAppointmentReminder: vi.fn(),
  markReminderDeliveryTimedOut: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/notifications/reminders", () => ({
  deliverAppointmentReminder: mocks.deliverAppointmentReminder,
  markReminderDeliveryTimedOut: mocks.markReminderDeliveryTimedOut,
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
 *
 * Codex round 4 (finding 1): the retry claim is now the SAME shape —
 * `retryRows` is a queue of one-row batches (`fn_claim_reminder_retries`
 * only ever claims a single delivery row per `p_limit: 1` call, unlike
 * the primary claim's up-to-3-rows-per-appointment fanout), and
 * `rpc("fn_claim_reminder_retries", ...)` shifts one row per call.
 */
function fakeSupabase(primaryBatches: RawRow[][], retried: RawRow[] = []) {
  const primaryQueue = [...primaryBatches];
  const retryQueue = [...retried];
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "fn_claim_appointment_reminders") {
      const batch = primaryQueue.shift();
      return { data: batch ?? [], error: null };
    }
    if (fn === "fn_claim_reminder_retries") {
      const row = retryQueue.shift();
      return { data: row ? [row] : [], error: null };
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

/** Calls to `rpc("fn_claim_reminder_retries", ...)` only. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function retryClaimCalls(supabase: any) {
  return supabase.rpc.mock.calls.filter(
    (call: unknown[]) => call[0] === "fn_claim_reminder_retries",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAppointmentReminderSweep", () => {
  it("claims appointments one at a time (p_limit: 1), delivers every channel row of each, and claims retries (first pass, then remainder)", async () => {
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
    // Codex round 5 (finding 1): retries are claimed in phase 1 (before
    // primaries) — one call that returns "c", plus the second call that
    // comes back empty and ends phase 1 — and phase 3 makes one more empty
    // call after primaries, since budget remains and retryRows.length is
    // still under retryLimit.
    for (const call of retryClaimCalls(supabase)) {
      expect(call[1]).toEqual({ p_limit: 1 });
    }
    expect(retryClaimCalls(supabase)).toHaveLength(3);
    expect(mocks.deliverAppointmentReminder).toHaveBeenCalledTimes(3);
    expect(summary.claimed).toBe(2);
    expect(summary.retried).toBe(1);
    expect(summary.processed).toBe(3);
  });

  it("Codex round 4 (finding 1): retry claims one row at a time inside the budget loop — a row the budget runs out before reaching is never claimed, so its attempts are never bumped by an unattempted claim", async () => {
    // Two retry-eligible rows queued, no primary backlog. Codex round 5:
    // retries now run in phase 1, BEFORE primaries, so this plays out
    // entirely inside phase 1 — the primary loop (phase 2) never even
    // starts once budget is exhausted here.
    const budgetMs = 1_000;
    const times = [
      0, // startedAt
      0, // phase 1 while-condition (elapsed < half-budget) — proceeds
      0, // retry loop: pre-claim check #1 — proceeds, claims "a"
      0, // retry loop: pre-delivery check for "a" — proceeds, delivers it
      0, // phase 1 while-condition (2nd iteration) — still under half-budget, proceeds
      budgetMs + 1, // retry loop: pre-claim check #2 — budget exhausted, "b" never claimed
    ];
    let call = 0;
    vi.spyOn(Date, "now").mockImplementation(
      () => times[Math.min(call++, times.length - 1)],
    );

    const supabase = fakeSupabase([], [rawRow("a"), rawRow("b")]);
    mocks.deliverAppointmentReminder.mockResolvedValue({
      status: "sent",
      deliveryId: "a",
      channel: "bell",
    });

    const summary = await runAppointmentReminderSweep(supabase, { budgetMs });

    // Only ONE retry claim call was ever made — "b" was never claimed by
    // fn_claim_reminder_retries at all, so its attempts (which that RPC
    // bumps atomically on every row it claims) were never spent on a
    // delivery attempt that couldn't happen this sweep.
    expect(retryClaimCalls(supabase)).toHaveLength(1);
    // Budget was already exhausted by the time phase 1 broke out, so phase
    // 2 (primaries) never ran at all — no primary claim call either.
    expect(primaryClaimCalls(supabase)).toHaveLength(0);
    expect(mocks.deliverAppointmentReminder).toHaveBeenCalledTimes(1);
    expect(mocks.deliverAppointmentReminder).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ deliveryId: "a" }),
    );
    expect(summary.retried).toBe(1);
    expect(summary.processed).toBe(1);
    expect(summary.budgetExhausted).toBe(true);
  });

  it("Codex round 3 (finding 1): budget exhaustion between claim calls leaves the next appointment UNCLAIMED, not pending — no claim call is made for it", async () => {
    // No retry-eligible rows queued, so phase 1 makes exactly one (empty)
    // retry-claim call and falls straight through to phase 2 (primaries).
    // startedAt read once; the budget check runs before every claim call.
    // Drive it so exactly one appointment is claimed+delivered in phase 2
    // and the second primary claim call never happens.
    const budgetMs = 1_000;
    const times = [
      0, // startedAt
      0, // phase 1 while-condition (elapsed < half-budget) — proceeds
      0, // retry loop: pre-claim check — proceeds, claims nothing (no retries queued), breaks phase 1
      0, // phase 2: pre-claim check for appointment "a" — proceeds, claims it
      0, // phase 2: pre-delivery check for "a" — proceeds, delivers it
      budgetMs + 1, // phase 2: pre-claim check for "b" — budget exhausted, never claimed
    ];
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
    expect(summary.retried).toBe(0);
    expect(summary.processed).toBe(1);
    expect(summary.budgetExhausted).toBe(true);
    // Codex round 5: phase 1 (retries-first) always makes at least one
    // retry-claim call before primaries — here it returns empty since
    // nothing is retry-eligible — but phase 3 (retry remainder) is skipped
    // because budget was exhausted by phase 2, so the retry RPC was called
    // exactly once, not skipped entirely.
    expect(retryClaimCalls(supabase)).toHaveLength(1);
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

  describe("Codex round 5 (finding 1): retries-first scheduling", () => {
    // Slow-delivery model: each delivery "costs" 2s of simulated time, so a
    // small budget only fits a few claim+deliver cycles — lets these tests
    // deterministically prove which phase got to run without hand-indexing
    // a Date.now() sequence for dozens of calls.
    const DELIVERY_COST_MS = 2_000;

    beforeEach(() => {
      vi.useFakeTimers();
      mocks.deliverAppointmentReminder.mockImplementation(async () => {
        await vi.advanceTimersByTimeAsync(DELIVERY_COST_MS);
        return { status: "sent", deliveryId: "x", channel: "bell" };
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("a sustained primary backlog does not starve an eligible retry within the sweep", async () => {
      // 20 primary appointments queued (sustained backlog) vs. a single
      // eligible retry. Budget only fits ~2 deliveries total.
      const primaryBatches = Array.from({ length: 20 }, (_, i) => [rawRow(`p${i}`)]);
      const supabase = fakeSupabase(primaryBatches, [rawRow("retry-1")]);

      const summary = await runAppointmentReminderSweep(supabase, {
        budgetMs: 5_000,
        retryLimit: 50,
        primaryClaimLimit: 50,
      });

      // The retry was processed in phase 1, before the primary backlog got
      // any budget at all — it is never starved regardless of how deep the
      // primary backlog is.
      expect(summary.retried).toBe(1);
      expect(summary.budgetExhausted).toBe(true);
    });

    it("a deep retry backlog does not fully starve primaries within the sweep", async () => {
      // 20 retry-eligible rows queued (deeper than RETRY_RESERVED_QUOTA)
      // vs. only 5 primary appointments. Budget is large enough that phase
      // 1's half-budget cap kicks in before its item cap or the full
      // budget, leaving room for phase 2 to claim every primary.
      const retried = Array.from({ length: 20 }, (_, i) => rawRow(`r${i}`));
      const primaryBatches = Array.from({ length: 5 }, (_, i) => [rawRow(`p${i}`)]);
      const supabase = fakeSupabase(primaryBatches, retried);

      const summary = await runAppointmentReminderSweep(supabase, {
        budgetMs: 30_000,
        retryLimit: 50,
        primaryClaimLimit: 50,
      });

      // All 5 primaries got claimed and delivered despite the much deeper
      // retry backlog — phase 1's reservation cap kept retries from
      // consuming the whole budget before primaries got a turn.
      expect(summary.claimed).toBe(5);
      expect(summary.retried).toBeGreaterThan(0);
      expect(summary.budgetExhausted).toBe(true);
    });
  });

  describe("Codex round 6 (finding 2): per-delivery deadlines", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("a hung retry delivery times out at the phase-1 boundary — phase 2 still claims and processes a primary", async () => {
      // Retry row is slack (provider-call channel, in scope for the
      // deadline race); primary row is the rawRow() default (bell) so its
      // delivery resolves immediately with no timer involved, isolating
      // what this test is actually proving: that the hang doesn't block
      // the sweep from reaching phase 2.
      const supabase = fakeSupabase(
        [[rawRow("primary-1")]],
        [rawRow("retry-1", { channel: "slack" })],
      );
      mocks.deliverAppointmentReminder
        .mockImplementationOnce(() => new Promise(() => {})) // never resolves
        .mockResolvedValueOnce({ status: "sent", deliveryId: "primary-1", channel: "bell" });

      const budgetMs = 10_000;
      const summaryPromise = runAppointmentReminderSweep(supabase, { budgetMs });

      // Phase 1's deadline for this row is halfBudgetMs (5s) — advance past
      // it so the route's Promise.race times the hung call out, then drain
      // the rest of the sweep (phase 2's primary resolves immediately, no
      // further timer needed).
      await vi.advanceTimersByTimeAsync(budgetMs / 2 + 100);
      await vi.advanceTimersByTimeAsync(budgetMs / 2);

      const summary = await summaryPromise;

      // The hung retry was claimed and attempted, but recorded as a timed-
      // out failure instead of blocking the loop.
      expect(summary.retried).toBe(1);
      expect(summary.outcomes.failed).toBe(1);
      expect(mocks.markReminderDeliveryTimedOut).toHaveBeenCalledTimes(1);
      const failureCall = mocks.reportError.mock.calls.find(
        (call) =>
          (call[1] as { tags?: { surface?: string } })?.tags?.surface ===
          "cron_appointment_reminder_sweep_outcome",
      );
      expect((failureCall?.[0] as Error)?.message).toBe("delivery timeout");

      // Phase 2 still ran and claimed/delivered the primary appointment.
      expect(summary.claimed).toBe(1);
      expect(summary.outcomes.sent).toBe(1);
      expect(summary.processed).toBe(2);
    });
  });
});
