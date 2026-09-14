import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
const mocks = vi.hoisted(() => ({ create: vi.fn(), unknownHistory: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.create }));
vi.mock("@/lib/inbox/read-api", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/inbox/read-api")>(), createInboxReadRepository: () => ({ unknownHistory: mocks.unknownHistory }) }));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const senderGroupId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const params = () => ({ params: Promise.resolve({ senderGroupId }) });
const request = (query = `orgId=${id}`) => new Request(`https://example.com/api/inbox/unknown-senders/${senderGroupId}/history?${query}`);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id } } });
  vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", id);
  mocks.unknownHistory.mockResolvedValue({ items: [] });
});
afterEach(() => vi.unstubAllEnvs());
describe("unknown-senders history deployment boundary", () => {
  it("defaults closed before client creation", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", undefined);
    expect((await GET(request(), params())).status).toBe(404); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns 404 and never calls the history RPC for a user outside the pilot allowlist (GL-4/G5)", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    mocks.getUser.mockResolvedValue({ data: { user: { id: "not-piloted-user" } } });
    expect((await GET(request(), params())).status).toBe(404); expect(mocks.unknownHistory).not.toHaveBeenCalled();
  });
  // MUTATION: removing the pilot check in route.ts makes this fail — the
  // out-of-cohort user would reach the history RPC and get 200.
  it("returns 404 when the allowlist is empty (default = nobody)", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", undefined);
    expect((await GET(request(), params())).status).toBe(404); expect(mocks.unknownHistory).not.toHaveBeenCalled();
  });
  it("returns history for a pilot user", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    const response = await GET(request(), params());
    expect(response.status).toBe(200);
    expect(mocks.unknownHistory).toHaveBeenCalledWith(id, senderGroupId, expect.anything(), undefined);
  });
});
