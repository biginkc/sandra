import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueueStatsBanner } from "./queue-stats-banner";

type Stats = {
  queued: number;
  paused: number;
  sentOutToday: number;
  failedToday: number;
  nextScheduledFor: string | null;
  lastScheduledFor: string | null;
};

const NOW_MS = Date.parse("2026-05-04T18:00:00Z");

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
  it("labels a stats failure instead of presenting fallback zeroes as truth", () => {
    const onRetry = vi.fn();
    render(
      <QueueStatsBanner
        stats={makeStats()}
        loadFailed
        onRetry={onRetry}
        nowMs={NOW_MS}
      />,
    );

    expect(screen.getByTestId("queue-stats-failure")).toHaveTextContent(
      "fallback totals are not an empty-queue confirmation",
    );
    expect(screen.queryByText(/0 queued/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry totals" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps last-good totals visible but marks them stale after a later failure", () => {
    render(
      <QueueStatsBanner
        stats={makeStats({ queued: 17, sentOutToday: 4 })}
        loadFailed
        lastSuccessfulAt="2026-05-04T17:59:30Z"
        nowMs={NOW_MS}
      />,
    );

    expect(screen.getByTestId("queue-stats-failure")).toHaveTextContent(
      "last good totals",
    );
    expect(screen.getByText(/17 queued/)).toBeInTheDocument();
    expect(screen.getByTestId("queue-stats-last-success")).toHaveTextContent(
      "May 4, 2026",
    );
  });

  it("Renders queued / sent out today / failed today counts from stats", () => {
    render(
      <QueueStatsBanner
        stats={makeStats({
          queued: 2509,
          sentOutToday: 12,
          failedToday: 3,
        })}
        nowMs={NOW_MS}
      />,
    );
    expect(screen.getByText(/2509 queued/)).toBeInTheDocument();
    expect(screen.getByText(/12 sent out today/)).toBeInTheDocument();
    expect(screen.getByText(/3 failed today/)).toBeInTheDocument();
  });

  it("Renders 'none queued' when nextScheduledFor is null", () => {
    render(<QueueStatsBanner stats={makeStats()} nowMs={NOW_MS} />);
    expect(screen.getByText(/Next release: none queued/i)).toBeInTheDocument();
  });

  it("Renders 'in Xs' / 'in Xm' relative time for nextScheduledFor in the future", () => {
    // nextScheduledFor = 30s from now → "in 30s"
    const { unmount } = render(
      <QueueStatsBanner
        stats={makeStats({
          nextScheduledFor: new Date("2026-05-04T18:00:30Z").toISOString(),
        })}
        nowMs={NOW_MS}
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
        nowMs={NOW_MS}
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
        nowMs={NOW_MS}
      />,
    );
    expect(screen.getByText(/drain ETA: 12h 32m/i)).toBeInTheDocument();
  });
});
