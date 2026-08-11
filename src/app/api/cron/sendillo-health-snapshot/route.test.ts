import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  inWindow: vi.fn(),
  createAdminClient: vi.fn(() => ({ role: "service" })),
  reportError: vi.fn(),
}));

vi.mock("@/lib/messages/sendillo-health-snapshot", () => ({
  captureSendilloSmsHealthSnapshot: mocks.capture,
}));
vi.mock("@/lib/skip-trace/balance", () => ({
  isWithinCreditRefreshWindow: mocks.inWindow,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import { GET, POST } from "./route";

const priorSecret = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = "cron-test-secret";
  vi.clearAllMocks();
  mocks.inWindow.mockReturnValue(true);
});

afterEach(() => {
  if (priorSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = priorSecret;
});

function request(token = "cron-test-secret") {
  return new Request("http://localhost/api/cron/sendillo-health-snapshot", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("Sendillo health snapshot cron", () => {
  it("rejects invalid or missing cron configuration", async () => {
    expect((await GET(request("wrong"))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(request())).status).toBe(500);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("skips outside the Central operating window", async () => {
    mocks.inWindow.mockReturnValue(false);
    const response = await GET(request());
    expect(await response.json()).toEqual({
      ok: true,
      skipped: "outside_business_window",
    });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("captures a snapshot through GET and POST", async () => {
    mocks.capture.mockResolvedValue({
      status: "available",
      health: {},
      updatedAt: "2026-08-10T16:15:00.000Z",
      stale: false,
    });
    expect(await (await GET(request())).json()).toEqual({
      ok: true,
      capturedAt: "2026-08-10T16:15:00.000Z",
    });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });

  it("returns 500 and reports a capture failure", async () => {
    mocks.capture.mockRejectedValue(new Error("database unavailable"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(mocks.reportError).toHaveBeenCalledOnce();
  });
});
