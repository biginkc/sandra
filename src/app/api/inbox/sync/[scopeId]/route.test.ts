import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import * as gateway from "@/lib/inbox/sync-gateway";
const mocks = vi.hoisted(() => ({ create: vi.fn(), rpc: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.create }));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const request = () => new Request(`https://example.com/api/inbox/sync/${id}`);
const params = () => ({ params: Promise.resolve({ scopeId: id }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ rpc: mocks.rpc, auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id } } });
  vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", id);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("sync deployment boundary", () => {
  it.each([undefined, "0", "true"])("defaults closed for flag %s before client creation", async flag => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", flag);
    expect((await GET(request(), params())).status).toBe(404); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("fails closed without fixed upstream configuration", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_ELECTRIC_SHAPE_URL", undefined);
    expect((await GET(request(), params())).status).toBe(503); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns 404 and never calls the sync RPC for a user outside the pilot allowlist (GL-4/G5)", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_ELECTRIC_UPSTREAM_MODE", "owned-local"); vi.stubEnv("INBOX_ELECTRIC_SHAPE_URL", "http://127.0.0.1:58783/v1/shape"); vi.stubEnv("INBOX_ELECTRIC_PROJECTION_TABLE", "inbox_t2_bridge.summary_rows");
    mocks.getUser.mockResolvedValue({ data: { user: { id: "not-piloted-user" } } });
    expect((await GET(request(), params())).status).toBe(404); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  // MUTATION: removing the pilot check in route.ts makes this fail — the
  // out-of-cohort user would reach inbox_sync_snapshot_v1.
  it("returns 404 when the allowlist is empty (default = nobody)", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_ELECTRIC_UPSTREAM_MODE", "owned-local"); vi.stubEnv("INBOX_ELECTRIC_SHAPE_URL", "http://127.0.0.1:58783/v1/shape"); vi.stubEnv("INBOX_ELECTRIC_PROJECTION_TABLE", "inbox_t2_bridge.summary_rows");
    vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", undefined);
    expect((await GET(request(), params())).status).toBe(404); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("uses cookie RPC authority and fails closed without deployed schema", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_ELECTRIC_UPSTREAM_MODE", "owned-local"); vi.stubEnv("INBOX_ELECTRIC_SHAPE_URL", "http://127.0.0.1:58783/v1/shape"); vi.stubEnv("INBOX_ELECTRIC_PROJECTION_TABLE", "inbox_t2_bridge.summary_rows");
    mocks.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: null, error: { code: "PGRST202", message: "private" } }) });
    const result = await GET(request(), params()); expect(result.status).toBe(503); expect(await result.text()).not.toContain("private");
    expect(mocks.rpc).toHaveBeenCalledWith("inbox_sync_snapshot_v1", { scope_id: id });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});

it("rejects hosted relay without its private token before RPC creation",async()=>{vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED","1");vi.stubEnv("INBOX_ELECTRIC_SHAPE_URL","https://relay.example/v1/shape");vi.stubEnv("INBOX_ELECTRIC_PROJECTION_TABLE","inbox_bridge.summaries");vi.stubEnv("INBOX_ELECTRIC_RELAY_TOKEN",undefined);vi.stubEnv("INBOX_ELECTRIC_UPSTREAM_MODE","relay");expect((await GET(request(),params())).status).toBe(503);expect(mocks.create).not.toHaveBeenCalled();});

it("passes the private relay authorization to the gateway configuration", async () => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
  vi.stubEnv("INBOX_ELECTRIC_SHAPE_URL", "https://relay.example/v1/shape");
  vi.stubEnv("INBOX_ELECTRIC_PROJECTION_TABLE", "inbox_bridge.summaries");
  vi.stubEnv("INBOX_ELECTRIC_UPSTREAM_MODE", "relay");
  const token = "a".repeat(64);
  vi.stubEnv("INBOX_ELECTRIC_RELAY_TOKEN", token);
  const makeGateway = vi.spyOn(gateway, "createInboxSyncGateway").mockReturnValue(async () => new Response("[]"));
  expect((await GET(request(), params())).status).toBe(200);
  expect(makeGateway).toHaveBeenCalledWith(expect.objectContaining({
    electricUrl: "https://relay.example/v1/shape",
    upstreamHeaders: { authorization: `Bearer ${token}` },
  }));
});
