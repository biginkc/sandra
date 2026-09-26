import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sync: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/coach/script-cache", () => ({ syncCoachScriptCache: mocks.sync }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));

import { GET } from "./route";

function request(authorization = "Bearer cron-secret") {
  return new Request("https://sandra.test/api/cron/coach-scripts-sync", { headers: { authorization } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("CLOSER_LAB_API_BASE_URL", "https://closer.test");
  vi.stubEnv("SANDRA_SERVICE_TOKEN", "shared-token");
  mocks.admin.mockReturnValue({});
  mocks.sync.mockResolvedValue({ ok: true, synced: 2 });
});

describe("GET /api/cron/coach-scripts-sync", () => {
  it("requires CRON_SECRET before syncing", async () => {
    const response = await GET(request("Bearer wrong"));
    expect(response.status).toBe(401);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("no-ops without Closer Lab configuration before making an admin client", async () => {
    vi.stubEnv("CLOSER_LAB_API_BASE_URL", "");
    const response = await GET(request());
    expect(await response.json()).toEqual({ ok: true, skipped: "missing_configuration" });
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("returns the cache sync outcome", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, synced: 2 });
    expect(mocks.sync).toHaveBeenCalledOnce();
  });
});
