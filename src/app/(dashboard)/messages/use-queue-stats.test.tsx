import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getQueueStats } = vi.hoisted(() => ({ getQueueStats: vi.fn() }));

vi.mock("./actions", () => ({
  getQueueStats,
}));

// eslint-disable-next-line import/first
import { useQueueStats } from "./use-queue-stats";

type Stats = {
  queued: number;
  sentToday: number;
  failedToday: number;
  nextScheduledFor: string | null;
  lastScheduledFor: string | null;
};

function makeStats(overrides: Partial<Stats> = {}): Stats {
  return {
    queued: 0,
    sentToday: 0,
    failedToday: 0,
    nextScheduledFor: null,
    lastScheduledFor: null,
    ...overrides,
  };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  getQueueStats.mockReset();
  // Default: visible.
  setVisibility("visible");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useQueueStats (260504-tgq polling, lifted from QueueStatsBanner)", () => {
  it("Returns initialStats before any poll fires", () => {
    const { result } = renderHook(() =>
      useQueueStats(makeStats({ queued: 42 })),
    );
    expect(result.current.queued).toBe(42);
    expect(getQueueStats).not.toHaveBeenCalled();
  });

  it("Polls getQueueStats every 30s when document is visible and returns fresh stats", async () => {
    getQueueStats.mockResolvedValue({
      ok: true,
      data: makeStats({ queued: 8964, sentToday: 385 }),
    });

    const { result } = renderHook(() => useQueueStats(makeStats()));

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(result.current.queued).toBe(8964);
    expect(result.current.sentToday).toBe(385);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getQueueStats).toHaveBeenCalledTimes(2);
  });

  it("Keeps previous stats when a poll returns ok: false", async () => {
    getQueueStats.mockResolvedValue({ ok: false, error: "boom" });

    const { result } = renderHook(() =>
      useQueueStats(makeStats({ queued: 7 })),
    );

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(result.current.queued).toBe(7);
  });

  it("Does NOT poll while document is hidden", async () => {
    getQueueStats.mockResolvedValue({
      ok: true,
      data: makeStats({ queued: 1 }),
    });

    renderHook(() => useQueueStats(makeStats()));
    setVisibility("hidden");

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(getQueueStats).not.toHaveBeenCalled();
  });

  it("Fires one immediate refresh when document transitions hidden → visible", async () => {
    getQueueStats.mockResolvedValue({
      ok: true,
      data: makeStats({ queued: 5 }),
    });

    setVisibility("hidden");
    const { result } = renderHook(() => useQueueStats(makeStats()));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(getQueueStats).not.toHaveBeenCalled();

    await act(async () => {
      setVisibility("visible");
      // Allow microtasks to flush so the promise resolves before assertion.
      await Promise.resolve();
    });
    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(result.current.queued).toBe(5);
  });

  it("Does not poll at all when enabled=false (Inbox tab)", async () => {
    getQueueStats.mockResolvedValue({
      ok: true,
      data: makeStats({ queued: 1 }),
    });

    const { result } = renderHook(() =>
      useQueueStats(makeStats({ queued: 9 }), { enabled: false }),
    );

    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(getQueueStats).not.toHaveBeenCalled();

    // Visibility transitions must also be inert while disabled.
    await act(async () => {
      setVisibility("hidden");
      setVisibility("visible");
      await Promise.resolve();
    });
    expect(getQueueStats).not.toHaveBeenCalled();
    // Still returns the server-fetched first-paint stats.
    expect(result.current.queued).toBe(9);
  });

  it("Clears interval and removes visibilitychange listener on unmount", async () => {
    getQueueStats.mockResolvedValue({
      ok: true,
      data: makeStats({ queued: 1 }),
    });

    const { unmount } = renderHook(() => useQueueStats(makeStats()));

    unmount();

    // Advancing the clock should not trigger any polls.
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(getQueueStats).not.toHaveBeenCalled();

    // Visibility transitions after unmount must also be inert.
    await act(async () => {
      setVisibility("hidden");
      setVisibility("visible");
      await Promise.resolve();
    });
    expect(getQueueStats).not.toHaveBeenCalled();
  });
});
