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

const ROW_A = { ledger_id: "ledger-a" } as never;
const ROW_B = { ledger_id: "ledger-b" } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("kickCalendarMutationSync", () => {
  it("claims a small batch (not just 1) and processes every claimed row against a shared deadline", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [ROW_A, ROW_B], error: null });
    processClaimedCalendarMutation.mockResolvedValue({ status: "no_event", ledgerId: "x" });

    await kickCalendarMutationSync({ rpc } as never);

    expect(rpc).toHaveBeenCalledWith("fn_claim_calendar_mutations", { p_limit: 5 });
    expect(processClaimedCalendarMutation).toHaveBeenCalledTimes(2);
    expect(processClaimedCalendarMutation).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      ROW_A,
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    expect(processClaimedCalendarMutation).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ROW_B,
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("no-ops cleanly when nothing is due", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    await expect(kickCalendarMutationSync({ rpc } as never)).resolves.toBeUndefined();
    expect(processClaimedCalendarMutation).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("swallows a claim RPC error — reports it, never rejects", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "db down" } });

    await expect(kickCalendarMutationSync({ rpc } as never)).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "inline_calendar_sync_kick" } }),
    );
  });

  it("one claimed row rejecting does not stop the rest of the batch, and is reported separately from a whole-kick failure", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [ROW_A, ROW_B], error: null });
    processClaimedCalendarMutation
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "no_event", ledgerId: "ledger-b" });

    await expect(kickCalendarMutationSync({ rpc } as never)).resolves.toBeUndefined();

    expect(processClaimedCalendarMutation).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { surface: "inline_calendar_sync_kick_unhandled" },
        extra: { ledgerId: "ledger-a" },
      }),
    );
    expect(reportError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: { surface: "inline_calendar_sync_kick" } }),
    );
  });

  it("never rejects even when every claimed row's processing rejects", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [ROW_A], error: null });
    processClaimedCalendarMutation.mockRejectedValue(new Error("always fails"));

    await expect(kickCalendarMutationSync({ rpc } as never)).resolves.toBeUndefined();
  });

  it("bounds the whole kick to timeoutMs — a hung claim call never keeps the caller waiting, and is reported as a timeout", async () => {
    const rpc = vi.fn(() => new Promise(() => {})); // never resolves

    const start = Date.now();
    await expect(
      kickCalendarMutationSync({ rpc } as never, { timeoutMs: 25 }),
    ).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);

    expect(reportError).toHaveBeenCalledTimes(1);
    const [errArg, meta] = reportError.mock.calls[0];
    expect(errArg).toBeInstanceOf(Error);
    expect((errArg as Error).message).toMatch(/timed out after 25ms/);
    expect(meta).toEqual(expect.objectContaining({ tags: { surface: "inline_calendar_sync_kick" } }));
  });

  it("a slow but successful run under the timeout still processes normally", async () => {
    const rpc = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ data: [ROW_A], error: null }), 10),
        ),
    );
    processClaimedCalendarMutation.mockResolvedValue({ status: "no_event", ledgerId: "ledger-a" });

    await expect(
      kickCalendarMutationSync({ rpc } as never, { timeoutMs: 500 }),
    ).resolves.toBeUndefined();

    expect(processClaimedCalendarMutation).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });
});
