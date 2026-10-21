import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { reportActionTiming } from "./client-action-timing";

const timing = { action: "loadWorkPage", route: "/my-leads", queueMs: 4200, networkMs: 300, totalMs: 4500, ok: true };
const sendBeacon = vi.fn(() => true);

beforeEach(() => {
  vi.stubGlobal("navigator", { sendBeacon });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("beacons only the sampled share", () => {
  reportActionTiming(timing, () => 0.05);
  reportActionTiming(timing, () => 0.5);
  expect(sendBeacon).toHaveBeenCalledTimes(1);
  expect(sendBeacon).toHaveBeenCalledWith("/api/telemetry/action-timing", expect.any(Blob));
});
