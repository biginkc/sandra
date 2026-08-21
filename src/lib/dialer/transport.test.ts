import { afterEach, describe, expect, it, vi } from "vitest";

import { SimulatedCallTransport } from "./transport";

describe("SimulatedCallTransport", () => {
  afterEach(() => vi.useRealTimers());

  it("walks the phase-2 seam from connecting to ringing to live and ends with duration", async () => {
    vi.useFakeTimers();
    const transport = new SimulatedCallTransport();
    const states: string[] = [];
    transport.onStateChange((state) => states.push(state));
    await transport.start({ phoneE164: "+18165550123" });
    await vi.advanceTimersByTimeAsync(130);
    const resultPromise = transport.hangup();
    const result = await resultPromise;
    expect(states).toEqual(["connecting", "ringing", "live", "ended"]);
    expect(result.outcome).toBe("connected_human");
    expect(result.durationSeconds).toBeGreaterThanOrEqual(0);
  });
});
