import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
const mocks = vi.hoisted(() => ({ create: vi.fn(), acknowledge: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.create }));
vi.mock("@/lib/inbox/read-api", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/inbox/read-api")>(), createInboxReadRepository: () => ({ acknowledge: mocks.acknowledge }) }));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const request = (body: string = JSON.stringify({ boundaryId: id, batch: 1 })) => new Request("https://example.com/api/inbox/read-acknowledgments", { method: "POST", headers: { "content-type": "application/json" }, body });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id } } });
  vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", id);
  mocks.acknowledge.mockResolvedValue({ acknowledged: true });
});
afterEach(() => vi.unstubAllEnvs());
describe("read-acknowledgments deployment boundary", () => {
  it("defaults closed before client creation", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", undefined);
    expect((await POST(request())).status).toBe(404); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns 404 and never calls the acknowledge RPC for a user outside the pilot allowlist (GL-4/G5)", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    mocks.getUser.mockResolvedValue({ data: { user: { id: "not-piloted-user" } } });
    expect((await POST(request())).status).toBe(404); expect(mocks.acknowledge).not.toHaveBeenCalled();
  });
  // MUTATION: removing the pilot check in route.ts makes this fail — the
  // out-of-cohort user would reach the acknowledge RPC and get 200.
  it("returns 404 when the allowlist is empty (default = nobody)", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", undefined);
    expect((await POST(request())).status).toBe(404); expect(mocks.acknowledge).not.toHaveBeenCalled();
  });
  it("acknowledges for a pilot user", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.acknowledge).toHaveBeenCalledWith(id, 1, expect.anything());
  });
});
