import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { run, report } = vi.hoisted(() => ({ run: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/hold-alerts", () => ({ runHoldAlertsForAllOrgs: run }));
vi.mock("@/lib/errors/report", () => ({ reportError: report }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({})) }));

import { ROUTE_MAX_DURATION_MS } from "@/lib/hold-alerts/types";

import { GET, POST, maxDuration } from "./route";

const req = (auth?: string) =>
  new Request("http://localhost/api/cron/hold-alerts", { headers: auth ? { authorization: auth } : {} });

describe("hold-alerts cron route", () => {
  it("keeps the interrupted-delivery window equal to the route's maxDuration", () => {
    expect(ROUTE_MAX_DURATION_MS).toBe(maxDuration * 1000);
  });

  beforeEach(() => {
    run.mockReset().mockResolvedValue({ orgs: 1, holds: 2, created: 3, sent: 3, skipped: 0, failed: 0, untouched: 0, errors: 0 });
    report.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns 500 when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(req("Bearer anything"))).status).toBe(500);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns 401 without or with a wrong bearer", async () => {
    vi.stubEnv("CRON_SECRET", "right");
    expect((await GET(req())).status).toBe(401);
    expect((await POST(req("Bearer wrong"))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs on GET and POST with the right bearer and returns the counts", async () => {
    vi.stubEnv("CRON_SECRET", "right");
    for (const handler of [GET, POST]) {
      const res = await handler(req("Bearer right"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, sent: 3, holds: 2 });
    }
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports and returns 500 when the run throws", async () => {
    vi.stubEnv("CRON_SECRET", "right");
    run.mockRejectedValue(new Error("db down"));
    const res = await GET(req("Bearer right"));
    expect(res.status).toBe(500);
    expect(report).toHaveBeenCalled();
  });
});
