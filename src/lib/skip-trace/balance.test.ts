import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSkipTraceProvider } = vi.hoisted(() => ({
  getSkipTraceProvider: vi.fn(),
}));

vi.mock("./registry", () => ({ getSkipTraceProvider }));

import {
  captureSkipTraceBalanceSnapshot,
  classifySkipTraceCredits,
  getStoredSkipTraceBalance,
  isWithinCreditRefreshWindow,
  SKIP_TRACE_CREDITS_METRIC_KEY,
} from "./balance";

beforeEach(() => {
  getSkipTraceProvider.mockReset();
});

describe("skip-trace credit snapshots", () => {
  it("classifies credit thresholds", () => {
    expect(classifySkipTraceCredits(19)).toBe("critical");
    expect(classifySkipTraceCredits(20)).toBe("low");
    expect(classifySkipTraceCredits(99)).toBe("low");
    expect(classifySkipTraceCredits(100)).toBe("ok");
  });

  it("enforces the 06:00-midnight America/Chicago window across DST", () => {
    expect(isWithinCreditRefreshWindow(new Date("2026-01-15T11:59:00Z"))).toBe(
      false,
    ); // 05:59 CST
    expect(isWithinCreditRefreshWindow(new Date("2026-01-15T12:00:00Z"))).toBe(
      true,
    ); // 06:00 CST
    expect(isWithinCreditRefreshWindow(new Date("2026-07-15T10:59:00Z"))).toBe(
      false,
    ); // 05:59 CDT
    expect(isWithinCreditRefreshWindow(new Date("2026-07-15T11:00:00Z"))).toBe(
      true,
    ); // 06:00 CDT
    expect(isWithinCreditRefreshWindow(new Date("2026-07-15T05:00:00Z"))).toBe(
      false,
    ); // 00:00 CDT
  });

  it("reads the latest stored value without obtaining a provider", async () => {
    const limit = vi.fn().mockResolvedValue({
      data: [{ numerator: 6692, captured_at: "2026-08-10T16:00:00.000Z" }],
      error: null,
    });
    const order = vi.fn(() => ({ limit }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    const result = await getStoredSkipTraceBalance({ from } as never);

    expect(result).toEqual({
      available: true,
      credits: 6692,
      tier: "ok",
      capturedAt: "2026-08-10T16:00:00.000Z",
    });
    expect(from).toHaveBeenCalledWith("metric_snapshots");
    expect(select).toHaveBeenCalledWith("numerator, captured_at");
    expect(eq).toHaveBeenCalledWith(
      "metric_key",
      SKIP_TRACE_CREDITS_METRIC_KEY,
    );
    expect(order).toHaveBeenCalledWith("captured_at", { ascending: false });
    expect(limit).toHaveBeenCalledWith(1);
    expect(getSkipTraceProvider).not.toHaveBeenCalled();
  });

  it("returns not_checked when no snapshot exists", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [], error: null });
    const from = vi.fn(() => ({
      select: () => ({ eq: () => ({ order: () => ({ limit }) }) }),
    }));
    await expect(getStoredSkipTraceBalance({ from } as never)).resolves.toEqual({
      available: false,
      reason: "not_checked",
    });
  });

  it("persists a valid provider value through the atomic newer-wins RPC", async () => {
    getSkipTraceProvider.mockReturnValue({
      getBalance: vi.fn().mockResolvedValue(4321),
    });
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const now = new Date("2026-08-10T17:15:00.000Z");

    await expect(
      captureSkipTraceBalanceSnapshot({ rpc } as never, now),
    ).resolves.toMatchObject({ credits: 4321, capturedAt: now.toISOString() });
    expect(rpc).toHaveBeenCalledWith("upsert_skip_trace_credit_snapshot", {
      p_credits: 4321,
      p_captured_at: now.toISOString(),
    });
  });

  it("does not write when the provider fails", async () => {
    getSkipTraceProvider.mockReturnValue({
      getBalance: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    });
    const rpc = vi.fn();

    await expect(
      captureSkipTraceBalanceSnapshot({ rpc } as never),
    ).rejects.toThrow("provider unavailable");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid provider balance %s without writing",
    async (credits) => {
      getSkipTraceProvider.mockReturnValue({
        getBalance: vi.fn().mockResolvedValue(credits),
      });
      const rpc = vi.fn();
      await expect(
        captureSkipTraceBalanceSnapshot({ rpc } as never),
      ).rejects.toThrow("invalid credit balance");
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("rejects a failed atomic snapshot write", async () => {
    getSkipTraceProvider.mockReturnValue({
      getBalance: vi.fn().mockResolvedValue(400),
    });
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "database unavailable" },
    });
    await expect(
      captureSkipTraceBalanceSnapshot({ rpc } as never),
    ).rejects.toThrow("database unavailable");
  });
});
