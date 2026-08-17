import { beforeEach, describe, expect, it, vi } from "vitest";

const { processClaimedCalendarMutation, reportError } = vi.hoisted(() => ({
  processClaimedCalendarMutation: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/integrations/google/create-worker", () => ({
  processClaimedCalendarMutation,
}));
vi.mock("@/lib/errors/report", () => ({ reportError }));

import { kickCalendarMutationSync } from "./inline-sync-kick";

const CLAIMED = { ledger_id: "ledger-a" } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("kickCalendarMutationSync", () => {
  it("claims only the supplied source task and processes exactly that row", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [CLAIMED], error: null });
    processClaimedCalendarMutation.mockResolvedValue({
      status: "no_event",
      ledgerId: "ledger-a",
    });

    await kickCalendarMutationSync({ rpc } as never, "ledger-a");

    expect(rpc).toHaveBeenCalledWith("fn_claim_calendar_mutation_for_ledger", {
      p_ledger_id: "ledger-a",
    });
    expect(processClaimedCalendarMutation).toHaveBeenCalledTimes(1);
    expect(processClaimedCalendarMutation).toHaveBeenCalledWith(
      expect.anything(),
      CLAIMED,
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    const deadlineAt = processClaimedCalendarMutation.mock.calls[0][2]
      .deadlineAt as number;
    expect(deadlineAt - Date.now()).toBeGreaterThan(9_000);
  });

  it("does not process anything when this task has no due mutation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    await kickCalendarMutationSync({ rpc } as never, "ledger-a");

    expect(processClaimedCalendarMutation).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports a claim failure without rejecting the committed action", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "db down" },
    });

    await expect(
      kickCalendarMutationSync({ rpc } as never, "ledger-a"),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { surface: "inline_calendar_sync_kick" },
        extra: { ledgerId: "ledger-a" },
      }),
    );
  });

  it("reports an unexpected worker rejection with the exact row identity", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [CLAIMED], error: null });
    processClaimedCalendarMutation.mockRejectedValue(new Error("boom"));

    await expect(
      kickCalendarMutationSync({ rpc } as never, "ledger-a"),
    ).resolves.toBeUndefined();

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { surface: "inline_calendar_sync_kick_unhandled" },
        extra: { ledgerId: "ledger-a" },
      }),
    );
  });

  it("bounds a hung claim and includes the exact ledger in telemetry", async () => {
    const rpc = vi.fn(() => new Promise(() => undefined));

    await expect(
      kickCalendarMutationSync({ rpc } as never, "ledger-a", { timeoutMs: 25 }),
    ).resolves.toBeUndefined();

    const [error, meta] = reportError.mock.calls[0];
    expect((error as Error).message).toMatch(/timed out after 25ms/);
    expect(meta).toEqual(
      expect.objectContaining({ extra: { ledgerId: "ledger-a" } }),
    );
  });
});
