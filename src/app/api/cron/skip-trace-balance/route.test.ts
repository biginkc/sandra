import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  inWindow: vi.fn(),
  createAdminClient: vi.fn(() => ({ role: "service" })),
  reportError: vi.fn(),
}));

vi.mock("@/lib/skip-trace/balance", () => ({
  captureSkipTraceBalanceSnapshot: mocks.capture,
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
  return new Request("http://localhost/api/cron/skip-trace-balance", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("skip-trace balance cron", () => {
  it("rejects an invalid cron secret", async () => {
    const response = await GET(request("wrong"));
    expect(response.status).toBe(401);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("skips without provider or DB access outside the Central-time window", async () => {
    mocks.inWindow.mockReturnValue(false);
    const response = await GET(request());
    expect(await response.json()).toEqual({
      ok: true,
      skipped: "outside_business_window",
    });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("stores and returns a scheduled snapshot inside the window", async () => {
    mocks.capture.mockResolvedValue({
      available: true,
      credits: 987,
      tier: "ok",
      capturedAt: "2026-08-10T18:00:00.000Z",
    });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      credits: 987,
      capturedAt: "2026-08-10T18:00:00.000Z",
    });
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("supports Vercel-compatible POST delivery with the same auth", async () => {
    mocks.capture.mockResolvedValue({
      available: true,
      credits: 654,
      tier: "ok",
      capturedAt: "2026-08-10T18:15:00.000Z",
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("returns 500 and leaves preservation to the no-write capture path", async () => {
    mocks.capture.mockRejectedValue(new Error("provider down"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(mocks.reportError).toHaveBeenCalledOnce();
  });
});
