import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
const mocks = vi.hoisted(() => ({ create: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.create }));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const request = () => new Request(`https://example.com/api/inbox/sync/${id}`);
const params = () => ({ params: Promise.resolve({ scopeId: id }) });
beforeEach(() => { vi.clearAllMocks(); mocks.create.mockResolvedValue({ rpc: mocks.rpc }); });
afterEach(() => vi.unstubAllEnvs());
describe("sync deployment boundary", () => {
  it.each([undefined, "0", "true"])("defaults closed for flag %s before client creation", async flag => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", flag);
    expect((await GET(request(), params())).status).toBe(404); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("fails closed without fixed upstream configuration", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_ELECTRIC_SHAPE_URL", undefined);
    expect((await GET(request(), params())).status).toBe(503); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("uses cookie RPC authority and fails closed without deployed schema", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_ELECTRIC_SHAPE_URL", "http://127.0.0.1:58783/v1/shape"); vi.stubEnv("INBOX_ELECTRIC_PROJECTION_TABLE", "inbox_t2_bridge.summary_rows");
    mocks.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: null, error: { code: "PGRST202", message: "private" } }) });
    const result = await GET(request(), params()); expect(result.status).toBe(503); expect(await result.text()).not.toContain("private");
    expect(mocks.rpc).toHaveBeenCalledWith("inbox_sync_snapshot_v1", { scope_id: id });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
