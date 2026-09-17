import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import { GET, POST } from "./route";

const priorSecret = process.env.CRON_SECRET;

function request(token = "cron-test-secret") {
  return new Request("https://sandra.test/api/cron/inbox-reply-callback-sweep", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("GET/POST /api/cron/inbox-reply-callback-sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron-test-secret";
  });
  afterEach(() => {
    process.env.CRON_SECRET = priorSecret;
  });

  it("returns 500 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(request());
    expect(response.status).toBe(500);
  });

  it("returns 401 for a missing/incorrect bearer token", async () => {
    const response = await GET(request("wrong"));
    expect(response.status).toBe(401);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("calls the reply-namespaced sweep RPC, never the Outbox's reconciliation RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { scanned: 3, drained: 2, failed: 0 }, error: null });
    mocks.createAdminClient.mockReturnValue({ rpc });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("inbox_reply_sweep_unmatched_callbacks", { batch_limit: 100 });
    const body = (await response.json()) as { ok: boolean; result: unknown };
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ scanned: 3, drained: 2, failed: 0 });
  });

  it("surfaces a 500 and reports when the sweep RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    mocks.createAdminClient.mockReturnValue({ rpc });
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(mocks.reportError).toHaveBeenCalled();
  });
});
