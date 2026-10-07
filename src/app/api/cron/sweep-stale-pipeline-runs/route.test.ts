import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sweep, lateSweep } = vi.hoisted(() => ({
  sweep: vi.fn(),
  lateSweep: vi.fn(async () => ({ scanned: 3, reconciled: 2, nextCursor: null, orphanMalformed: 1 })),
}));
vi.mock("@/lib/pipeline-runs", () => ({ sweepStalePipelineRuns: sweep }));
vi.mock("@/lib/ai-responder/dispatch", () => ({ sweepLateSends: lateSweep }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({})) }));

import { GET } from "./route";

const req = (auth?: string) =>
  new Request("http://localhost/api/cron/sweep-stale-pipeline-runs", {
    headers: auth ? { authorization: auth } : {},
  });

describe("sweep-stale-pipeline-runs cron route", () => {
  beforeEach(() => {
    sweep.mockReset().mockResolvedValue({ swept: 2 });
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns 500 when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await GET(req("Bearer anything"));
    expect(res.status).toBe(500);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong bearer token", async () => {
    vi.stubEnv("CRON_SECRET", "right");
    const res = await GET(req("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("returns 200 and sweeps with the correct bearer token", async () => {
    vi.stubEnv("CRON_SECRET", "right");
    const res = await GET(req("Bearer right"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      swept: 2,
      lateSends: { scanned: 3, reconciled: 2, nextCursor: null, orphanMalformed: 1 },
    });
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
