import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processClaimedCalendarMutation: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/integrations/google/create-worker", () => ({
  processClaimedCalendarMutation: mocks.processClaimedCalendarMutation,
}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import { runCalendarMutationSweep } from "./route";
import type { ClaimedCalendarMutationRow } from "@/lib/integrations/google/create-worker";

/** Fake row `fn_claim_calendar_mutations` would return for one claim. */
function claimedRow(
  id: string,
  overrides: Partial<ClaimedCalendarMutationRow> = {},
): ClaimedCalendarMutationRow {
  return {
    ledger_id: id,
    org_id: "org-1",
    calendar_chain_id: "chain-1",
    operation: "create",
    phase: "pending",
    source_task_id: `task-${id}`,
    target_task_id: null,
    old_assignee_id: "assignee-1",
    new_assignee_id: null,
    event_id: null,
    new_event_id: null,
    client_event_id: "evtclient1",
    result_reason: null,
    old_event_deleted_at: null,
    expected_generation: 0,
    attempts: 1,
    claim_token: `token-${id}`,
    source_due_at: "2026-09-01T15:00:00.000Z",
    source_end_at: "2026-09-01T15:30:00.000Z",
    source_title: "Walkthrough",
    source_assignee_id: "assignee-1",
    target_due_at: null,
    target_end_at: null,
    target_title: null,
    target_assignee_id: null,
    ...overrides,
  };
}

/** Fake Supabase client: `rpc` special-cases the exhaustion sweep (called
 *  once per `runCalendarMutationSweep` invocation, before any claiming)
 *  and otherwise hands back one queued row per call so the route's
 *  one-at-a-time claim (`p_limit: 1`) is exercised the same way the real
 *  RPC would be — a fresh claim call per row, not one upfront batch. */
function fakeSupabase(
  rows: ClaimedCalendarMutationRow[],
  expiredCount = 0,
  needsRepairCount = 0,
) {
  const queue = [...rows];
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "fn_expire_exhausted_calendar_mutations") {
      return {
        data: [{ failed_count: expiredCount, needs_repair_count: needsRepairCount }],
        error: null,
      };
    }
    const row = queue.shift();
    return { data: row ? [row] : [], error: null };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { rpc } as any;
}

/** Calls to `rpc("fn_claim_calendar_mutations", ...)` only, filtering out
 *  the once-per-sweep exhaustion call so existing call-count assertions
 *  keep meaning "how many rows were claimed" rather than "how many rpc
 *  calls total". */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function claimCalls(supabase: any) {
  return supabase.rpc.mock.calls.filter(
    (call: unknown[]) => call[0] === "fn_claim_calendar_mutations",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCalendarMutationSweep", () => {
  it("claims and processes rows one at a time, always via p_limit: 1", async () => {
    const supabase = fakeSupabase([claimedRow("a"), claimedRow("b")]);
    mocks.processClaimedCalendarMutation.mockResolvedValue({
      status: "created",
      ledgerId: "a",
      eventId: "evt-a",
    });

    await runCalendarMutationSweep(supabase, { budgetMs: 60_000 });

    expect(supabase.rpc).toHaveBeenCalledWith("fn_claim_calendar_mutations", {
      p_limit: 1,
    });
    expect(supabase.rpc).toHaveBeenCalledWith("fn_expire_exhausted_calendar_mutations");
    for (const call of claimCalls(supabase)) {
      expect(call[1]).toEqual({ p_limit: 1 });
    }
  });

  it("stops claiming once the budget is exhausted, mid-sweep — a row's attempts only get burned when the worker is actually about to process it", async () => {
    // startedAt read once, then the budget check runs once per loop
    // iteration (before every claim). Sequence: startedAt=0, first
    // check=0 (inside budget, claim proceeds), second check=budgetMs+1
    // (processing the first row "consumed" the whole budget) — the loop
    // must exit there WITHOUT issuing a second claim.
    const budgetMs = 1_000;
    const times = [0, 0, budgetMs + 1];
    let call = 0;
    vi.spyOn(Date, "now").mockImplementation(
      () => times[Math.min(call++, times.length - 1)],
    );

    const supabase = fakeSupabase([claimedRow("a"), claimedRow("b")]);
    mocks.processClaimedCalendarMutation.mockResolvedValue({
      status: "created",
      ledgerId: "a",
      eventId: "evt-a",
    });

    const summary = await runCalendarMutationSweep(supabase, { budgetMs });

    expect(claimCalls(supabase)).toHaveLength(1);
    expect(mocks.processClaimedCalendarMutation).toHaveBeenCalledTimes(1);
    expect(summary.claimed).toBe(1);
    expect(summary.budgetExhausted).toBe(true);
  });

  it("stops when the claim RPC returns no row, without treating it as budget exhaustion", async () => {
    const supabase = fakeSupabase([]);

    const summary = await runCalendarMutationSweep(supabase, {
      budgetMs: 60_000,
    });

    expect(claimCalls(supabase)).toHaveLength(1);
    expect(mocks.processClaimedCalendarMutation).not.toHaveBeenCalled();
    expect(summary.claimed).toBe(0);
    expect(summary.budgetExhausted).toBe(false);
  });

  it("caps total rows processed per sweep at claimLimit", async () => {
    const supabase = fakeSupabase([claimedRow("a"), claimedRow("b"), claimedRow("c")]);
    mocks.processClaimedCalendarMutation.mockResolvedValue({
      status: "created",
      ledgerId: "a",
      eventId: "evt-a",
    });

    const summary = await runCalendarMutationSweep(supabase, {
      budgetMs: 60_000,
      claimLimit: 2,
    });

    expect(claimCalls(supabase)).toHaveLength(2);
    expect(summary.claimed).toBe(2);
  });

  it("runs the exhaustion sweep once per invocation, before any claiming, and surfaces failed/needs_repair separately", async () => {
    const supabase = fakeSupabase([claimedRow("a")], 3, 2);
    mocks.processClaimedCalendarMutation.mockResolvedValue({
      status: "created",
      ledgerId: "a",
      eventId: "evt-a",
    });

    const summary = await runCalendarMutationSweep(supabase, { budgetMs: 60_000 });

    expect(summary.expired).toBe(3);
    expect(summary.needsRepair).toBe(2);
    const calls = supabase.rpc.mock.calls;
    expect(calls[0][0]).toBe("fn_expire_exhausted_calendar_mutations");
    expect(calls.filter((c: unknown[]) => c[0] === "fn_expire_exhausted_calendar_mutations")).toHaveLength(1);
  });

  it("a rejecting first row doesn't prevent the second row from being claimed and processed", async () => {
    // Defense-in-depth: even though processClaimedCalendarMutation is
    // documented to never throw, the sweep loop must not bet the whole
    // run on that invariant — an unexpected rejection on one claimed row
    // must not abort the loop before the next row is claimed.
    const supabase = fakeSupabase([claimedRow("a"), claimedRow("b")]);
    mocks.processClaimedCalendarMutation
      .mockRejectedValueOnce(new Error("transport blew up"))
      .mockResolvedValueOnce({ status: "created", ledgerId: "b", eventId: "evt-b" });

    const summary = await runCalendarMutationSweep(supabase, {
      budgetMs: 60_000,
      claimLimit: 2,
    });

    expect(claimCalls(supabase)).toHaveLength(2);
    expect(mocks.processClaimedCalendarMutation).toHaveBeenCalledTimes(2);
    expect(summary.claimed).toBe(2);
    expect(summary.outcomes.sweep_level_error).toBe(1);
    expect(summary.outcomes.created).toBe(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { surface: "cron_calendar_mutation_sweep_unhandled" },
      }),
    );
  });

  it("reports needs_repair telemetry with the count and row ids when the exhaustion sweep finds repair rows", async () => {
    const supabase = fakeSupabase([], 0, 0);
    supabase.rpc = vi.fn(async (fn: string) => {
      if (fn === "fn_expire_exhausted_calendar_mutations") {
        return {
          data: [
            {
              failed_count: 0,
              needs_repair_count: 2,
              needs_repair_ids: ["ledger-x", "ledger-y"],
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });

    const summary = await runCalendarMutationSweep(supabase, { budgetMs: 60_000 });

    expect(summary.needsRepair).toBe(2);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { surface: "calendar-mutation-sweep", kind: "needs_repair" },
        extra: { needsRepairCount: 2, needsRepairIds: ["ledger-x", "ledger-y"] },
      }),
    );
  });

  it("does not report needs_repair telemetry when the exhaustion sweep finds nothing to repair", async () => {
    const supabase = fakeSupabase([], 0, 0);

    await runCalendarMutationSweep(supabase, { budgetMs: 60_000 });

    expect(mocks.reportError).not.toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ kind: "needs_repair" }) }),
    );
  });

  it("reports finalize_conflict telemetry with the ledger id and task id", async () => {
    const supabase = fakeSupabase([claimedRow("a")]);
    mocks.processClaimedCalendarMutation.mockResolvedValue({
      status: "finalize_conflict",
      ledgerId: "a",
      eventId: "evt-a",
      taskId: "task-a",
    });

    const summary = await runCalendarMutationSweep(supabase, { budgetMs: 60_000 });

    expect(summary.outcomes.finalize_conflict).toBe(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { surface: "cron_calendar_mutation_sweep_outcome", kind: "finalize_conflict" },
        extra: { ledgerId: "a", taskId: "task-a" },
      }),
    );
  });

  it("throws if the exhaustion sweep RPC errors, without claiming anything", async () => {
    const supabase = fakeSupabase([claimedRow("a")]);
    supabase.rpc = vi.fn(async (fn: string) =>
      fn === "fn_expire_exhausted_calendar_mutations"
        ? { data: null, error: { message: "boom" } }
        : { data: [], error: null },
    );

    await expect(runCalendarMutationSweep(supabase, { budgetMs: 60_000 })).rejects.toThrow(
      /fn_expire_exhausted_calendar_mutations failed/,
    );
    expect(mocks.processClaimedCalendarMutation).not.toHaveBeenCalled();
  });

  it("dispatches a claimed cancel/reschedule/reassign row through processClaimedCalendarMutation same as create", async () => {
    const supabase = fakeSupabase([
      claimedRow("c", { operation: "cancel" }),
    ]);
    mocks.processClaimedCalendarMutation.mockResolvedValue({
      status: "deleted",
      ledgerId: "c",
    });

    const summary = await runCalendarMutationSweep(supabase, { budgetMs: 60_000 });

    expect(mocks.processClaimedCalendarMutation).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ operation: "cancel" }),
    );
    expect(summary.outcomes.deleted).toBe(1);
  });
});
