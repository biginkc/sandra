import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  getClient: vi.fn(() => ({})),
  captureCheckIn: vi.fn(() => "check-in-1"),
  flush: vi.fn(async () => true),
}));
vi.mock("@sentry/nextjs", () => sentry);

import { cronResponseFailed, runMonitoredCron } from "./cron-monitor";

const config = {
  schedule: { type: "crontab" as const, value: "*/5 * * * *" },
  checkinMargin: 2,
  maxRuntime: 4,
};

describe("cron check-ins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sentry.getClient.mockReturnValue({});
  });

  it("records success and preserves the response", async () => {
    const response = Response.json({ ok: true });
    expect(await runMonitoredCron("test-job", config, async () => response, cronResponseFailed)).toBe(response);
    expect(sentry.captureCheckIn).toHaveBeenNthCalledWith(1,
      { monitorSlug: "test-job", status: "in_progress" }, config);
    expect(sentry.captureCheckIn).toHaveBeenNthCalledWith(2,
      { monitorSlug: "test-job", checkInId: "check-in-1", status: "ok" });
  });

  it("records HTTP 200 with ok=false as a failed run", async () => {
    await runMonitoredCron("test-job", config, async () => Response.json({ ok: false, secret: "never sent" }), cronResponseFailed);
    expect(sentry.captureCheckIn).toHaveBeenLastCalledWith(
      { monitorSlug: "test-job", checkInId: "check-in-1", status: "error" });
    expect(JSON.stringify(sentry.captureCheckIn.mock.calls)).not.toContain("never sent");
  });

  it("records thrown errors and preserves the original exception", async () => {
    const failure = new Error("business failure");
    await expect(runMonitoredCron("test-job", config, async () => { throw failure; }, () => false)).rejects.toBe(failure);
    expect(sentry.captureCheckIn).toHaveBeenLastCalledWith(
      { monitorSlug: "test-job", checkInId: "check-in-1", status: "error" });
  });

  it("does not change business results when monitoring is unavailable", async () => {
    sentry.getClient.mockReturnValueOnce(null as never);
    const result = await runMonitoredCron("test-job", config, async () => 42, () => false);
    expect(result).toBe(42);
    expect(sentry.captureCheckIn).not.toHaveBeenCalled();
  });

  it("classifies HTTP errors without reading their body", async () => {
    expect(await cronResponseFailed(new Response("secret", { status: 500 }))).toBe(true);
  });
});
