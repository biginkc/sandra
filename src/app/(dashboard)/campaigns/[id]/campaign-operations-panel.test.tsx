import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CampaignOperationsPanel } from "./campaign-operations-panel";

describe("<CampaignOperationsPanel />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T18:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("separates queue setup from live send progress", () => {
    render(
      <CampaignOperationsPanel
        stats={{
          campaignStatus: "completed",
          audience: 120,
          queued: 42,
          paused: 0,
          dueQueued: 3,
          pending: 1,
          sent: 7,
          delivered: 55,
          failed: 2,
          handedOff: 62,
          replied: 9,
          optedOut: 1,
          nextScheduledFor: "2026-06-30T18:00:30.000Z",
          lastScheduledFor: "2026-06-30T20:30:00.000Z",
          paceSeconds: 8,
          job: {
            id: "job-1",
            status: "completed",
            totalItems: 120,
            processedItems: 120,
            succeededItems: 118,
            failedItems: 2,
            errorMessage: null,
          },
        }}
      />,
    );

    expect(screen.getByText("Live send progress")).toBeInTheDocument();
    expect(
      screen.getByText("Queue setup: queue built; still sending"),
    ).toBeInTheDocument();
    expect(screen.getByText("Frozen audience")).toBeInTheDocument();
    expect(screen.getByText("Queued to send")).toBeInTheDocument();
    expect(screen.getByText("Handed to provider")).toBeInTheDocument();
    expect(screen.getByText("Next send")).toBeInTheDocument();
    expect(screen.getByText("in 30s")).toBeInTheDocument();
    expect(screen.getByText("2h 30m")).toBeInTheDocument();
    expect(
      screen.getByText(/Queue-building job: completed · 118 queued, 2 failed of 120/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Cadence: 8s/)).toBeInTheDocument();
  });

  it("does not show a future drain ETA when queued rows are already overdue", () => {
    render(
      <CampaignOperationsPanel
        stats={{
          campaignStatus: "completed",
          audience: 120,
          queued: 42,
          paused: 0,
          dueQueued: 42,
          pending: 0,
          sent: 7,
          delivered: 55,
          failed: 2,
          handedOff: 64,
          replied: 9,
          optedOut: 1,
          nextScheduledFor: "2026-06-30T17:55:00.000Z",
          lastScheduledFor: "2026-06-30T17:59:30.000Z",
          paceSeconds: 8,
          job: null,
        }}
      />,
    );

    expect(screen.getByText("draining now")).toBeInTheDocument();
    expect(screen.queryByText("<1m")).toBeNull();
  });
});
