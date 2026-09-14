import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
const mocks = vi.hoisted(() => ({ create: vi.fn(), rpc: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.create }));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ rpc: mocks.rpc, auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id } } });
  vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", id);
});
afterEach(() => vi.unstubAllEnvs());
const request = (origin?: string) => new Request("https://example.com/api/inbox/worksets", { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: "{}" });
describe("worksets deployment boundary", () => {
  it.each([undefined, "0", "true"])("defaults closed for flag %s before authenticating", async flag => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", flag);
    expect((await POST(request())).status).toBe(404); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects cross-origin scope mutation", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    expect((await POST(request("https://foreign.example"))).status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns 404 and never calls the workset RPC for a user outside the pilot allowlist (GL-4/G5)", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    mocks.getUser.mockResolvedValue({ data: { user: { id: "not-piloted-user" } } });
    expect((await POST(request())).status).toBe(404); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  // MUTATION: removing the pilot check in route.ts makes this fail — the
  // out-of-cohort user would reach inbox_authorize_sync and proceed.
  it("returns 404 when the allowlist is empty (default = nobody)", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", undefined);
    expect((await POST(request())).status).toBe(404); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([["42501", "INBOX_SESSION_EXPIRED", 401], ["42501", "INBOX_ORG_DENIED", 403], ["22023", "INBOX_INVALID_WORKSET", 400], ["55000", "INBOX_GENERATION_RATE", 429]])("preserves canonical domain denial %s/%s", async (code, message, status) => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    mocks.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: null, error: { code, message } }) });
    const result = await POST(request()); expect(result.status).toBe(status); expect(await result.text()).not.toContain(message);
  });
  it("uses real repository and fails closed with absent deployed schema", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    mocks.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: null, error: { code: "PGRST202", message: "private" } }) });
    const result = await POST(request()); expect(result.status).toBe(503); expect(await result.text()).not.toContain("private");
    expect(mocks.rpc).toHaveBeenCalledWith("inbox_authorize_sync", { org_id: null });
  });
});
