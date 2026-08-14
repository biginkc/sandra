import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processClaimedCalendarCreation: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/integrations/google/create-worker", () => ({
  processClaimedCalendarCreation: mocks.processClaimedCalendarCreation,
}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import { runCalendarMutationSweep } from "./route";
import type { ClaimedCalendarCreationRow } from "@/lib/integrations/google/create-worker";

/** Fake row `fn_claim_calendar_creations` would return for one claim. */
function claimedRow(id: string): ClaimedCalendarCreationRow {
  return {
    ledger_id: id,
    org_id: "org-1",
    calendar_chain_id: "chain-1",
    source_task_id: `task-${id}`,
    expected_generation: 0,
    client_event_id: "evtclient1",
    attempts: 1,
    phase: "pending",
    new_event_id: null,
    result_reason: null,
    task_due_at: "2026-09-01T15:00:00.000Z",
    task_end_at: "2026-09-01T15:30:00.000Z",
    task_title: "Walkthrough",
    task_assignee_id: "assignee-1",
  };
}

/** Fake Supabase client: `rpc` special-cases the exhaustion sweep (called
 *  once per `runCalendarMutationSweep` invocation, before any claiming)
 *  and otherwise hands back one queued row per call so the route's
 *  one-at-a-time claim (`p_limit: 1`) is exercised the same way the real
 *  RPC would be — a fresh claim call per row, not one upfront batch. */
function fakeSupabase(rows: ClaimedCalendarCreationRow[], expiredCount = 0) {
  const queue = [...rows];
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "fn_expire_exhausted_calendar_creations") {
      return { data: expiredCount, error: null };
    }
    const row = queue.shift();
    return { data: row ? [row] : [], error: null };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { rpc } as any;
}

/** Calls to `rpc("fn_claim_calendar_creations", ...)` only, filtering out
 *  the once-per-sweep exhaustion call so existing call-count assertions
 *  keep meaning "how many rows were claimed" rather than "how many rpc
 *  calls total". */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function claimCalls(supabase: any) {
  return supabase.rpc.mock.calls.filter(
    (call: unknown[]) => call[0] === "fn_claim_calendar_creations",
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
    mocks.processClaimedCalendarCreation.mockResolvedValue({
      status: "created",
      ledgerId: "a",
      eventId: "evt-a",
    });

    await runCalendarMutationSweep(supabase, { budgetMs: 60_000 });

    expect(supabase.rpc).toHaveBeenCalledWith("fn_claim_calendar_creations", {
      p_limit: 1,
    });
    expect(supabase.rpc).toHaveBeenCalledWith("fn_expire_exhausted_calendar_creations");
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
    mocks.processClaimedCalendarCreation.mockResolvedValue({
      status: "created",
      ledgerId: "a",
      eventId: "evt-a",
    });

    const summary = await runCalendarMutationSweep(supabase, { budgetMs });

    expect(claimCalls(supabase)).toHaveLength(1);
    expect(mocks.processClaimedCalendarCreation).toHaveBeenCalledTimes(1);
    expect(summary.claimed).toBe(1);
    expect(summary.budgetExhausted).toBe(true);
  });

  it("stops when the claim RPC returns no row, without treating it as budget exhaustion", async () => {
    const supabase = fakeSupabase([]);

    const summary = await runCalendarMutationSweep(supabase, {
      budgetMs: 60_000,
    });

    expect(claimCalls(supabase)).toHaveLength(1);
    expect(mocks.processClaimedCalendarCreation).not.toHaveBeenCalled();
    expect(summary.claimed).toBe(0);
    expect(summary.budgetExhausted).toBe(false);
  });

  it("caps total rows processed per sweep at claimLimit", async () => {
    const supabase = fakeSupabase([claimedRow("a"), claimedRow("b"), claimedRow("c")]);
    mocks.processClaimedCalendarCreation.mockResolvedValue({
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

  it("runs the exhaustion sweep once per invocation, before any claiming, and surfaces its count", async () => {
    const supabase = fakeSupabase([claimedRow("a")], 3);
    mocks.processClaimedCalendarCreation.mockResolvedValue({
      status: "created",
      ledgerId: "a",
      eventId: "evt-a",
    });

    const summary = await runCalendarMutationSweep(supabase, { budgetMs: 60_000 });

    expect(summary.expired).toBe(3);
    const calls = supabase.rpc.mock.calls;
    expect(calls[0][0]).toBe("fn_expire_exhausted_calendar_creations");
    expect(calls.filter((c: unknown[]) => c[0] === "fn_expire_exhausted_calendar_creations")).toHaveLength(1);
  });

  it("throws if the exhaustion sweep RPC errors, without claiming anything", async () => {
    const supabase = fakeSupabase([claimedRow("a")]);
    supabase.rpc = vi.fn(async (fn: string) =>
      fn === "fn_expire_exhausted_calendar_creations"
        ? { data: null, error: { message: "boom" } }
        : { data: [], error: null },
    );

    await expect(runCalendarMutationSweep(supabase, { budgetMs: 60_000 })).rejects.toThrow(
      /fn_expire_exhausted_calendar_creations failed/,
    );
    expect(mocks.processClaimedCalendarCreation).not.toHaveBeenCalled();
  });
});
