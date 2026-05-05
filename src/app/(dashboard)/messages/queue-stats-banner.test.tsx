import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getQueueStats } = vi.hoisted(() => ({ getQueueStats: vi.fn() }));

vi.mock("./actions", () => ({
  getQueueStats,
}));

// eslint-disable-next-line import/first
import { QueueStatsBanner } from "./queue-stats-banner";

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
  // Anchor "now" so relative-time assertions are deterministic.
  vi.setSystemTime(new Date("2026-05-04T18:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<QueueStatsBanner /> (260504-tgq)", () => {
  it("Renders queued / sent today / failed today counts from initialStats", () => {
    render(
      <QueueStatsBanner
        initialStats={makeStats({
          queued: 2509,
          sentToday: 12,
          failedToday: 3,
        })}
      />,
    );
    expect(screen.getByText(/2509 queued/)).toBeInTheDocument();
    expect(screen.getByText(/12 sent today/)).toBeInTheDocument();
    expect(screen.getByText(/3 failed today/)).toBeInTheDocument();
  });

  it("Renders 'none queued' when nextScheduledFor is null", () => {
    render(<QueueStatsBanner initialStats={makeStats()} />);
    expect(screen.getByText(/Next release: none queued/i)).toBeInTheDocument();
  });

  it("Renders 'in Xs' / 'in Xm' relative time for nextScheduledFor in the future", () => {
    // nextScheduledFor = 30s from now → "in 30s"
    const { unmount } = render(
      <QueueStatsBanner
        initialStats={makeStats({
          nextScheduledFor: new Date("2026-05-04T18:00:30Z").toISOString(),
        })}
      />,
    );
    expect(screen.getByText(/Next release: in 30s/i)).toBeInTheDocument();
    unmount();

    // nextScheduledFor = 5m from now → "in 5m"
    render(
      <QueueStatsBanner
        initialStats={makeStats({
          nextScheduledFor: new Date("2026-05-04T18:05:00Z").toISOString(),
        })}
      />,
    );
    expect(screen.getByText(/Next release: in 5m/i)).toBeInTheDocument();
  });

  it("Renders drain ETA as 'Xh Ym' when lastScheduledFor is hours away", () => {
    // lastScheduledFor = now + 12h32m → "12h 32m"
    const future = new Date("2026-05-05T06:32:00Z").toISOString();
    render(
      <QueueStatsBanner
        initialStats={makeStats({
          lastScheduledFor: future,
        })}
      />,
    );
    expect(screen.getByText(/drain ETA: 12h 32m/i)).toBeInTheDocument();
  });

  it("Polls getQueueStats every 30s when document is visible (advance 30s twice → 2 calls)", async () => {
    getQueueStats.mockResolvedValue({
      ok: true,
      data: makeStats({ queued: 1 }),
    });

    render(<QueueStatsBanner initialStats={makeStats()} />);

    expect(getQueueStats).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getQueueStats).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getQueueStats).toHaveBeenCalledTimes(2);
  });

  it("Does NOT poll while document is hidden", async () => {
    getQueueStats.mockResolvedValue({
      ok: true,
      data: makeStats({ queued: 1 }),
    });

    render(<QueueStatsBanner initialStats={makeStats()} />);
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
    render(<QueueStatsBanner initialStats={makeStats()} />);

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
  });

  it("Clears interval and removes visibilitychange listener on unmount", async () => {
    getQueueStats.mockResolvedValue({
      ok: true,
      data: makeStats({ queued: 1 }),
    });

    const { unmount } = render(
      <QueueStatsBanner initialStats={makeStats()} />,
    );

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
