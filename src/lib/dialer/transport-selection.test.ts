import { afterEach, describe, expect, it, vi } from "vitest";

import { JitterCallTransport } from "./jitter-transport";
import {
  createSoftphoneCallTransport,
  isJitterTransportEnabled,
  isSoftphoneTransportEnabled,
} from "./transport-selection";
import { SimulatedCallTransport } from "./transport";

describe("softphone transport selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects Jitter explicitly", () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "jitter");
    expect(isJitterTransportEnabled()).toBe(true);
    expect(isSoftphoneTransportEnabled()).toBe(true);
    expect(createSoftphoneCallTransport()).toBeInstanceOf(JitterCallTransport);
  });

  it("preserves simulated behavior and disabled-by-default behavior", () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
    expect(createSoftphoneCallTransport()).toBeInstanceOf(SimulatedCallTransport);
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "");
    expect(isSoftphoneTransportEnabled()).toBe(false);
    expect(() => createSoftphoneCallTransport()).toThrow(/disabled/);
  });
});
