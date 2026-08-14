import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliverAppointmentReminder: vi.fn(),
  markReminderDeliveryTimedOut: vi.fn(),
  resolveTimedOutReminderDelivery: vi.fn(),
  reportError: vi.fn(),
  after: vi.fn(),
}));

vi.mock("@/lib/notifications/reminders", () => ({
  deliverAppointmentReminder: mocks.deliverAppointmentReminder,
  markReminderDeliveryTimedOut: mocks.markReminderDeliveryTimedOut,
  resolveTimedOutReminderDelivery: mocks.resolveTimedOutReminderDelivery,
}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));
// Codex round 7 (finding 1): `withDeliveryDeadline` now registers a
// post-response continuation via `after()` on a timeout. `after()` throws
// outside a real Next.js request scope — which is exactly how these tests
// call `runAppointmentReminderSweep` (directly, not through GET/POST) — so
// it's stubbed the same way as the Slack actions webhook route test
// (src/app/api/webhooks/slack/actions/route.test.ts) to just capture the
// callback instead of invoking it inline.
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (fn: () => Promise<void>) => mocks.after(fn),
  };
});

import { runAppointmentReminderSweep, sweepStaleDispatchingReminders } from "./route";

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
  related_property_id: string | null;
  contact_id: string | null;
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
    related_property_id: null,
    contact_id: null,
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

    // sms goes through `withDeliveryDeadline` (Codex round 6), which now
    // also passes the deadline's AbortSignal as a third arg (Codex round 7,
    // finding 1, item 5).
    expect(mocks.deliverAppointmentReminder).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        deliveryId: "a",
        taskId: "task-a",
        orgId: "org-1",
        channel: "sms",
        assigneeReminderPhone: "+18165551234",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
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

      // The hung retry was claimed and attempted, but recorded as
      // timeout_ambiguous instead of blocking the loop or (Codex round 7,
      // finding 1 — supersedes round 6) being marked an immediately
      // retryable "failed", which would risk a duplicate send if the
      // abandoned call later actually reaches the provider.
      expect(summary.retried).toBe(1);
      expect(summary.outcomes.timeout_ambiguous).toBe(1);
      expect(summary.outcomes.failed).toBeUndefined();
      expect(mocks.markReminderDeliveryTimedOut).toHaveBeenCalledTimes(1);
      const ambiguousCall = mocks.reportError.mock.calls.find(
        (call) =>
          (call[1] as { tags?: { surface?: string } })?.tags?.surface ===
          "cron_appointment_reminder_sweep_outcome_ambiguous",
      );
      expect((ambiguousCall?.[0] as Error)?.message).toBe(
        "delivery timeout, completion ambiguous",
      );

      // A continuation was registered via after() to reconcile the still-
      // running call once it settles.
      expect(mocks.after).toHaveBeenCalledTimes(1);

      // Phase 2 still ran and claimed/delivered the primary appointment.
      expect(summary.claimed).toBe(1);
      expect(summary.outcomes.sent).toBe(1);
      expect(summary.processed).toBe(2);
    });
  });

  describe("Codex round 7 (finding 1): late resolution after a timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Drives a single sms row past its delivery deadline (never-resolving
     *  provider promise until the test manually resolves `deferred`), then
     *  returns the `after()` continuation callback that was registered so
     *  the test can invoke it directly — same pattern the sweep route
     *  itself uses in production, just not wired to a real Next.js request
     *  scope here (see the `next/server` mock above). */
    async function driveOneTimedOutDelivery(): Promise<{
      resolveDeferred: (outcome: unknown) => void;
      continuation: () => Promise<void>;
    }> {
      let resolveDeferred!: (outcome: unknown) => void;
      const deferred = new Promise((resolve) => {
        resolveDeferred = resolve;
      });
      const supabase = fakeSupabase([[rawRow("a", { channel: "sms" })]]);
      mocks.deliverAppointmentReminder.mockReturnValueOnce(deferred);

      const budgetMs = 10_000;
      const summaryPromise = runAppointmentReminderSweep(supabase, { budgetMs });
      await vi.advanceTimersByTimeAsync(budgetMs / 2 + 100);
      await vi.advanceTimersByTimeAsync(budgetMs / 2);
      await summaryPromise;

      expect(mocks.after).toHaveBeenCalledTimes(1);
      const continuation = mocks.after.mock.calls[0][0] as () => Promise<void>;
      return { resolveDeferred, continuation };
    }

    it("late success reconciles the row to sent with the real provider id — no second provider call", async () => {
      const { resolveDeferred, continuation } = await driveOneTimedOutDelivery();

      resolveDeferred({ status: "sent", deliveryId: "a", channel: "sms", providerMessageId: "snd_late_1" });
      await continuation();

      expect(mocks.resolveTimedOutReminderDelivery).toHaveBeenCalledTimes(1);
      expect(mocks.resolveTimedOutReminderDelivery).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ deliveryId: "a" }),
        expect.objectContaining({ status: "sent", providerMessageId: "snd_late_1" }),
      );
      // The delivery worker itself was only ever invoked once for this row
      // — the continuation reconciles the SAME settled promise, it never
      // triggers a second provider call.
      expect(mocks.deliverAppointmentReminder).toHaveBeenCalledTimes(1);
    });

    it("late definite failure reconciles the row to failed (now safely retryable)", async () => {
      const { resolveDeferred, continuation } = await driveOneTimedOutDelivery();

      resolveDeferred({ status: "failed", deliveryId: "a", channel: "sms", error: "provider rejected" });
      await continuation();

      expect(mocks.resolveTimedOutReminderDelivery).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ deliveryId: "a" }),
        expect.objectContaining({ status: "failed", error: "provider rejected" }),
      );
    });

    it("an unexpected rejection is reported but the row is left ambiguous, not guessed at", async () => {
      let rejectDeferred!: (error: unknown) => void;
      const deferred = new Promise((_resolve, reject) => {
        rejectDeferred = reject;
      });
      const supabase = fakeSupabase([[rawRow("a", { channel: "sms" })]]);
      mocks.deliverAppointmentReminder.mockReturnValueOnce(deferred);

      const budgetMs = 10_000;
      const summaryPromise = runAppointmentReminderSweep(supabase, { budgetMs });
      await vi.advanceTimersByTimeAsync(budgetMs / 2 + 100);
      await vi.advanceTimersByTimeAsync(budgetMs / 2);
      await summaryPromise;

      const continuation = mocks.after.mock.calls[0][0] as () => Promise<void>;
      rejectDeferred(new Error("truly unexpected"));
      await continuation();

      expect(mocks.resolveTimedOutReminderDelivery).not.toHaveBeenCalled();
      const lateRejectionCall = mocks.reportError.mock.calls.find(
        (call) =>
          (call[1] as { tags?: { surface?: string } })?.tags?.surface ===
          "cron_appointment_reminder_sweep_late_rejection",
      );
      expect((lateRejectionCall?.[0] as Error)?.message).toBe("truly unexpected");
    });
  });

  // Codex round 8 (finding introduced) + round 10 (finding 2): an
  // `aborted_ambiguous` outcome doesn't only come from the sweep's OWN
  // deadline race (`withDeliveryDeadline`'s TIMED_OUT branch) — Sendillo's
  // own internal send timeout can settle `deliverAppointmentReminder`
  // FIRST, before the sweep's deadline ever fires, so the outcome comes
  // back through the race's `result !== TIMED_OUT` branch directly. Round
  // 10 (finding 2) moved the actual DB fencing (claimedStatus ->
  // timeout_ambiguous) into `deliverAppointmentReminder` itself for exactly
  // this path (see reminders.test.ts) — this route-level test asserts the
  // CONTROL FLOW around it: the timeout-race machinery
  // (`markReminderDeliveryTimedOut` / `after()` / `resolveTimedOutReminderDelivery`)
  // must never fire for a row that resolved before the deadline, so nothing
  // double-fences or double-reports it, and the row is excluded from the
  // NEXT sweep's retry claim purely by virtue of now sitting at
  // `timeout_ambiguous` (fn_claim_reminder_retries's candidates CTE only
  // ever matches `status IN ('failed', 'pending')` — 20260814200000).
  describe("Codex round 10 (finding 2): direct aborted_ambiguous, not via the timeout race", () => {
    it("an internal-abort outcome that settles before the deadline is reported once, with no timeout-race bookkeeping — the row's fence is deliverAppointmentReminder's own responsibility", async () => {
      const supabase = fakeSupabase([[rawRow("a", { channel: "sms" })]]);
      mocks.deliverAppointmentReminder.mockResolvedValueOnce({
        status: "aborted_ambiguous",
        deliveryId: "a",
        channel: "sms",
        lastError: "Sendillo's own send timeout fired",
      });

      const summary = await runAppointmentReminderSweep(supabase, { budgetMs: 10_000 });

      expect(summary.outcomes.aborted_ambiguous).toBe(1);
      // Never went through the timeout race at all — settled before any
      // deadline timer could fire.
      expect(mocks.markReminderDeliveryTimedOut).not.toHaveBeenCalled();
      expect(mocks.after).not.toHaveBeenCalled();
      expect(mocks.resolveTimedOutReminderDelivery).not.toHaveBeenCalled();
      const ambiguousCall = mocks.reportError.mock.calls.find(
        (call) =>
          (call[1] as { tags?: { surface?: string } })?.tags?.surface ===
          "cron_appointment_reminder_sweep_outcome_ambiguous",
      );
      expect((ambiguousCall?.[0] as Error)?.message).toBe("Sendillo's own send timeout fired");
      // Reported exactly once — no double report from a race that never
      // happened.
      expect(
        mocks.reportError.mock.calls.filter(
          (call) =>
            (call[1] as { tags?: { surface?: string } })?.tags?.surface ===
            "cron_appointment_reminder_sweep_outcome_ambiguous",
        ),
      ).toHaveLength(1);
    });
  });
});

// Codex round 12 (finding 2): the operator-safety catch-all that sweeps a
// row abandoned mid-dispatch (crashed between the provider accepting the
// message and the outcome write landing) into timeout_ambiguous after it's
// been 'dispatching' too long.
describe("sweepStaleDispatchingReminders", () => {
  /** Minimal fake for `.from("task_reminder_deliveries").update(...).eq(...).lt(...).select("id")`. */
  function fakeUpdateSupabase(opts: { error?: { message: string } | null; ids?: string[] }) {
    const calls: { payload: unknown; eqs: [string, unknown][]; lt: [string, unknown] | null }[] = [];
    const from = vi.fn((table: string) => ({
      update: vi.fn((payload: unknown) => {
        const record = { payload, eqs: [] as [string, unknown][], lt: null as [string, unknown] | null };
        calls.push(record);
        const builder = {
          eq: vi.fn((column: string, value: unknown) => {
            record.eqs.push([column, value]);
            return builder;
          }),
          lt: vi.fn((column: string, value: unknown) => {
            record.lt = [column, value];
            return builder;
          }),
          select: vi.fn(async () => ({
            data: opts.error ? null : (opts.ids ?? []).map((id) => ({ id })),
            error: opts.error ?? null,
          })),
        };
        return builder;
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { from, calls } as any;
  }

  it("transitions stale 'dispatching' rows (past the threshold) into timeout_ambiguous, fenced by status='dispatching' and dispatching_at < cutoff", async () => {
    const supabase = fakeUpdateSupabase({ ids: ["delivery-1", "delivery-2"] });

    await sweepStaleDispatchingReminders(supabase);

    expect(supabase.calls).toHaveLength(1);
    expect(supabase.calls[0].payload).toMatchObject({
      status: "timeout_ambiguous",
      last_error: expect.stringContaining("stale dispatching"),
    });
    expect(supabase.calls[0].eqs).toContainEqual(["status", "dispatching"]);
    expect(supabase.calls[0].lt![0]).toBe("dispatching_at");
  });

  it("reports telemetry when rows were swept", async () => {
    const supabase = fakeUpdateSupabase({ ids: ["delivery-1"] });

    await sweepStaleDispatchingReminders(supabase);

    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { surface: "cron_appointment_reminder_sweep_stale_dispatching" },
        extra: { count: 1 },
      }),
    );
  });

  it("reports nothing when no rows were stale", async () => {
    const supabase = fakeUpdateSupabase({ ids: [] });

    await sweepStaleDispatchingReminders(supabase);

    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("reports (but does not throw on) a query error", async () => {
    const supabase = fakeUpdateSupabase({ error: { message: "db down" } });

    await expect(sweepStaleDispatchingReminders(supabase)).resolves.toBeUndefined();

    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "cron_appointment_reminder_sweep_stale_dispatching" } }),
    );
  });
});
