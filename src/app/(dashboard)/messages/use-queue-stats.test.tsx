import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getQueueStats } = vi.hoisted(() => ({ getQueueStats: vi.fn() }));

vi.mock("./actions", () => ({
  getQueueStats,
}));

import { useQueueStats } from "./use-queue-stats";

type Stats = {
  queued: number;
  paused: number;
  sentOutToday: number;
  failedToday: number;
  nextScheduledFor: string | null;
  lastScheduledFor: string | null;
};

function makeStats(overrides: Partial<Stats> = {}): Stats {
  return {
    queued: 0,
    paused: 0,
    sentOutToday: 0,
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
      data: makeStats({ queued: 8964, sentOutToday: 385 }),
    });

    const { result } = renderHook(() => useQueueStats(makeStats()));

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(result.current.queued).toBe(8964);
    expect(result.current.sentOutToday).toBe(385);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getQueueStats).toHaveBeenCalledTimes(2);
  });

  it("Keeps previous stats when a poll returns ok: false", async () => {
    getQueueStats.mockResolvedValue({ ok: false, error: "boom" });
    const onRefreshFailure = vi.fn();

    const { result } = renderHook(() =>
      useQueueStats(makeStats({ queued: 7 }), { onRefreshFailure }),
    );

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(result.current.queued).toBe(7);
    expect(onRefreshFailure).toHaveBeenCalledOnce();
  });

  it("reports a successful poll so a failed first-paint indicator can recover", async () => {
    const onRefreshSuccess = vi.fn();
    getQueueStats.mockResolvedValue({
      ok: true,
      data: makeStats({ queued: 12, sentOutToday: 4 }),
    });

    const { result } = renderHook(() =>
      useQueueStats(makeStats(), { onRefreshSuccess }),
    );

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    expect(onRefreshSuccess).toHaveBeenCalledOnce();
    expect(result.current).toMatchObject({ queued: 12, sentOutToday: 4 });
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

  it("Adopts fresh server stats from props while disabled (Inbox rerender)", () => {
    const { result, rerender } = renderHook(
      ({ stats }) => useQueueStats(stats, { enabled: false }),
      { initialProps: { stats: makeStats({ queued: 100 }) } },
    );
    expect(result.current.queued).toBe(100);

    // A new RSC render hands down fresh server stats — no polling needed.
    rerender({ stats: makeStats({ queued: 8964, sentOutToday: 385 }) });
    expect(result.current.queued).toBe(8964);
    expect(result.current.sentOutToday).toBe(385);
    expect(getQueueStats).not.toHaveBeenCalled();
  });

  it("Switching to Outbox uses the fresh server stats immediately, before any poll", () => {
    const { result, rerender } = renderHook(
      ({ stats, enabled }) => useQueueStats(stats, { enabled }),
      {
        initialProps: {
          stats: makeStats({ queued: 100 }),
          enabled: false,
        },
      },
    );

    // Tab switch: enabled flips true AND the force-dynamic page delivers
    // freshly fetched stats in the same render.
    rerender({ stats: makeStats({ queued: 42 }), enabled: true });
    expect(result.current.queued).toBe(42);
    expect(getQueueStats).not.toHaveBeenCalled();
  });

  it("Discards an in-flight poll that started before fresh server props arrived", async () => {
    // Deferred poll: starts on the 30s tick, resolves only when we say so.
    let resolvePoll: (v: unknown) => void = () => {};
    getQueueStats.mockImplementation(
      () => new Promise((resolve) => (resolvePoll = resolve)),
    );

    const { result, rerender } = renderHook(
      ({ stats }) => useQueueStats(stats, { enabled: true }),
      { initialProps: { stats: makeStats({ queued: 100 }) } },
    );

    // Start a poll; it stays pending.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getQueueStats).toHaveBeenCalledTimes(1);

    // A router.refresh()-driven RSC payload lands with fresh numbers.
    rerender({ stats: makeStats({ queued: 42 }) });
    expect(result.current.queued).toBe(42);

    // The stale poll finally resolves with pre-refresh numbers — it must
    // NOT overwrite the fresher server payload.
    await act(async () => {
      resolvePoll({ ok: true, data: makeStats({ queued: 100 }) });
      await Promise.resolve();
    });
    expect(result.current.queued).toBe(42);
  });

  it("Two overlapping polls apply newest-started-wins, regardless of resolve order", async () => {
    // Each call gets its own deferred so we control resolve order.
    const resolvers: Array<(v: unknown) => void> = [];
    getQueueStats.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );

    const { result } = renderHook(() => useQueueStats(makeStats()));

    // Poll A starts on the first tick, poll B on the second — A still pending.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(resolvers).toHaveLength(2);

    // B (newer) resolves first and applies.
    await act(async () => {
      resolvers[1]({ ok: true, data: makeStats({ queued: 7 }) });
      await Promise.resolve();
    });
    expect(result.current.queued).toBe(7);

    // A (older) resolves late with stale numbers — must NOT overwrite B.
    await act(async () => {
      resolvers[0]({ ok: true, data: makeStats({ queued: 3 }) });
      await Promise.resolve();
    });
    expect(result.current.queued).toBe(7);
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
