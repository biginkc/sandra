import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueueStatsBanner } from "./queue-stats-banner";

type Stats = {
  queued: number;
  sentOutToday: number;
  failedToday: number;
  nextScheduledFor: string | null;
  lastScheduledFor: string | null;
};

function makeStats(overrides: Partial<Stats> = {}): Stats {
  return {
    queued: 0,
    sentOutToday: 0,
    failedToday: 0,
    nextScheduledFor: null,
    lastScheduledFor: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Anchor "now" so relative-time assertions are deterministic.
  vi.setSystemTime(new Date("2026-05-04T18:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// Polling behavior (30s interval, visibility gating, cleanup) lives in
// useQueueStats and is covered by use-queue-stats.test.ts.
describe("<QueueStatsBanner /> (260504-tgq)", () => {
  it("Renders queued / sent out today / failed today counts from stats", () => {
    render(
      <QueueStatsBanner
        stats={makeStats({
          queued: 2509,
          sentOutToday: 12,
          failedToday: 3,
        })}
      />,
    );
    expect(screen.getByText(/2509 queued/)).toBeInTheDocument();
    expect(screen.getByText(/12 sent out today/)).toBeInTheDocument();
    expect(screen.getByText(/3 failed today/)).toBeInTheDocument();
  });

  it("Renders 'none queued' when nextScheduledFor is null", () => {
    render(<QueueStatsBanner stats={makeStats()} />);
    expect(screen.getByText(/Next release: none queued/i)).toBeInTheDocument();
  });

  it("Renders 'in Xs' / 'in Xm' relative time for nextScheduledFor in the future", () => {
    // nextScheduledFor = 30s from now → "in 30s"
    const { unmount } = render(
      <QueueStatsBanner
        stats={makeStats({
          nextScheduledFor: new Date("2026-05-04T18:00:30Z").toISOString(),
        })}
      />,
    );
    expect(screen.getByText(/Next release: in 30s/i)).toBeInTheDocument();
    unmount();

    // nextScheduledFor = 5m from now → "in 5m"
    render(
      <QueueStatsBanner
        stats={makeStats({
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
        stats={makeStats({
          lastScheduledFor: future,
        })}
      />,
    );
    expect(screen.getByText(/drain ETA: 12h 32m/i)).toBeInTheDocument();
  });
});
