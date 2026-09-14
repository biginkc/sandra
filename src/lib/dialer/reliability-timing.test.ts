import { describe, expect, it, vi } from "vitest";

import {
  createReliabilityTimingSession,
  publishPendingReliabilityTiming,
  readReliabilityClock,
  takePendingReliabilityTiming,
  type ReliabilityTimingMarker,
} from "./reliability-timing";

describe("reliability timing markers", () => {
  it("pairs monotonic and epoch clocks and reports the sampling uncertainty", () => {
    const monotonic = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(104);
    expect(readReliabilityClock({ monotonicNow: monotonic, epochNow: () => 1_700_000_000_000 })).toEqual({
      atMonotonicMs: 102,
      atEpochMs: 1_700_000_000_000,
      clockUncertaintyMs: 2,
    });
  });

  it("keeps click and startup markers until the exact call store is attached", async () => {
    let tick = 10;
    const session = createReliabilityTimingSession({
      monotonicNow: () => tick,
      epochNow: () => 1_000 + tick,
    });
    const writes: ReliabilityTimingMarker[] = [];
    const sink = { writeTiming: vi.fn(async (marker: ReliabilityTimingMarker) => { writes.push(marker); }) };

    session.mark("ui_click");
    tick = 20;
    session.mark("ui_handler");
    session.mark("backend_accepted", { source: "server_action_response" });
    expect(writes).toHaveLength(0);

    session.bind("run_123", "call-123");
    await session.attach(sink);
    expect(writes.map((marker) => marker.stage)).toEqual([
      "ui_click", "ui_handler", "backend_accepted",
    ]);
    expect(writes.every((marker) => marker.clockUncertaintyMs >= 1)).toBe(true);

    tick = 30;
    session.mark("operator_ringing");
    session.detach();
    tick = 40;
    session.mark("operator_live");
    await session.attach(sink);
    expect(writes.at(-1)?.atEpochMs).toBe(1_040);
    expect(sink.writeTiming).toHaveBeenCalledTimes(5);
  });

  it("passes one pending session to the transport and consumes it", () => {
    const session = createReliabilityTimingSession();
    publishPendingReliabilityTiming(session);
    expect(takePendingReliabilityTiming()).toBe(session);
    expect(takePendingReliabilityTiming()).toBeNull();
  });
});
