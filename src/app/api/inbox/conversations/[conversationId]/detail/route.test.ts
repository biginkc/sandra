import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
const mocks = vi.hoisted(() => ({ create: vi.fn(), detail: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.create }));
vi.mock("@/lib/inbox/read-api", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/inbox/read-api")>(), createInboxReadRepository: () => ({ detail: mocks.detail }) }));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const params = () => ({ params: Promise.resolve({ conversationId }) });
const request = (query = `orgId=${id}`) => new Request(`https://example.com/api/inbox/conversations/${conversationId}/detail?${query}`);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id } } });
  vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", id);
  mocks.detail.mockResolvedValue({ id: conversationId });
});
afterEach(() => vi.unstubAllEnvs());
describe("conversation detail deployment boundary", () => {
  it("defaults closed before client creation", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", undefined);
    expect((await GET(request(), params())).status).toBe(404); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns 404 and never calls the detail RPC for a user outside the pilot allowlist (GL-4/G5)", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    mocks.getUser.mockResolvedValue({ data: { user: { id: "not-piloted-user" } } });
    expect((await GET(request(), params())).status).toBe(404); expect(mocks.detail).not.toHaveBeenCalled();
  });
  // MUTATION: removing the pilot check in route.ts makes this fail — the
  // out-of-cohort user would reach the detail RPC and get 200.
  it("returns 404 when the allowlist is empty (default = nobody)", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", undefined);
    expect((await GET(request(), params())).status).toBe(404); expect(mocks.detail).not.toHaveBeenCalled();
  });
  it("returns detail for a pilot user", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    const response = await GET(request(), params());
    expect(response.status).toBe(200);
    expect(mocks.detail).toHaveBeenCalledWith(id, conversationId, expect.anything(), undefined);
  });
});
