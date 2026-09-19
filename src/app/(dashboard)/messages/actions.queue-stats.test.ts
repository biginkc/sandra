import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getCallerMembershipsOrThrow, getOutboundSmsMetrics } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getCallerMembershipsOrThrow: vi.fn(),
  getOutboundSmsMetrics: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("@/lib/messages/message-metrics", () => ({
  getOutboundSmsMetrics,
}));
vi.mock("@/lib/auth/memberships", () => ({
  getCallerMembershipsOrThrow,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

import { getQueueStats } from "./actions";

const metrics = {
  outboundRows: 19,
  queued: 42,
  paused: 4,
  dueQueued: 3,
  pending: 1,
  sent: 7,
  delivered: 5,
  failed: 2,
  handedOff: 12,
  attempted: 14,
  handedOffToday: 9,
  failedToday: 1,
  nextScheduledFor: "2026-06-30T18:00:00.000Z",
  lastScheduledFor: "2026-06-30T20:00:00.000Z",
  dayBounds: {
    timeZone: "America/Chicago",
    startIso: "2026-06-30T05:00:00.000Z",
    endIso: "2026-07-01T05:00:00.000Z",
  },
};

describe("getQueueStats", () => {
  beforeEach(() => {
  vi.clearAllMocks();
  getCallerMembershipsOrThrow.mockResolvedValue([
    { user_id: "user-1", org_id: "org-1", role: "member", acquisitions_enabled: false },
  ]);
  });

  it("uses the session client and maps shared outbound SMS metrics to the Outbox contract", async () => {
    const supabase = { from: vi.fn() };
    createClient.mockResolvedValue(supabase);
    getOutboundSmsMetrics.mockResolvedValue(metrics);

    const result = await getQueueStats();

    expect(result).toEqual({
      ok: true,
      data: {
        queued: 42,
        paused: 4,
        sentOutToday: 9,
        failedToday: 1,
        nextScheduledFor: "2026-06-30T18:00:00.000Z",
        lastScheduledFor: "2026-06-30T20:00:00.000Z",
      },
    });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(getOutboundSmsMetrics).toHaveBeenCalledWith(supabase);
  });

  it("surfaces shared metric failures to the caller", async () => {
    createClient.mockResolvedValue({ from: vi.fn() });
    getOutboundSmsMetrics.mockRejectedValue(new Error("metrics failed"));

    const result = await getQueueStats();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("QUEUE_STATS_FAILED");
    expect(result.error.message).toContain("metrics failed");
  });

  it("denies queue stats to an active Acquisitions member", async () => {
    getCallerMembershipsOrThrow.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member", acquisitions_enabled: true },
    ]);
    createClient.mockResolvedValue({ from: vi.fn() });

    const result = await getQueueStats();

    expect(result).toEqual({
      ok: false,
      error: {
        code: "QUEUE_STATS_FAILED",
        message: "Messages workspace access is unavailable.",
      },
    });
    expect(getOutboundSmsMetrics).not.toHaveBeenCalled();
  });
});
