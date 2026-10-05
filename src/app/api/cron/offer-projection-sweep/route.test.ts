import { beforeEach, describe, expect, it, vi } from "vitest";

const sweep = vi.hoisted(() => vi.fn());
vi.mock("@/lib/my-leads/offer-projection", () => ({ sweepOfferProjections: sweep }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { GET } from "./route";

const req = (auth?: string) => new Request("http://x.test/api/cron/offer-projection-sweep", { headers: auth ? { authorization: auth } : {} });

describe("offer-projection-sweep cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
  });
  it("401 without the cron secret and never sweeps", async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer wrong"))).status).toBe(401);
    expect(sweep).not.toHaveBeenCalled();
  });
  it("returns the sweep summary", async () => {
    sweep.mockResolvedValue({ repaired: 1, projected: 2, conflicts: 0 });
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, repaired: 1, projected: 2, conflicts: 0 });
  });
  it("503 when the sweep throws", async () => {
    sweep.mockRejectedValue(new Error("x"));
    expect((await GET(req("Bearer s3cret"))).status).toBe(503);
  });
});
