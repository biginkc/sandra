import { afterEach, describe, expect, it, vi } from "vitest";

import { SimulatedCallTransport, isSimulatedTransportEnabled } from "./transport";

describe("SimulatedCallTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("walks the phase-2 seam from connecting to ringing to live and ends with duration", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
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

  it("is disabled in production unless preview staging explicitly opts in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
    expect(isSimulatedTransportEnabled()).toBe(false);
    expect(() => new SimulatedCallTransport()).toThrow(/disabled/);

    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_ALLOW_SIMULATED", "true");
    expect(isSimulatedTransportEnabled()).toBe(true);
  });
});
