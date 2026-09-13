import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
import { GET } from "@/app/api/inbox/conversations/[conversationId]/detail/route";
import { POST } from "@/app/api/inbox/read-acknowledgments/route";
const boundaryId = "33333333-3333-3333-3333-333333333333";
const params = { params: Promise.resolve({ conversationId: boundaryId }) };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://inbox.test/api/inbox/read-acknowledgments", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
  mocks.createClient.mockResolvedValue({ rpc: mocks.rpc });
  mocks.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: { boundary_id: boundaryId, batch: 0, changed: 1, completed: true }, error: null }) }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("disabled-by-default Inbox read routes", () => {
  it("does not construct clients for either disabled route", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "");
    expect((await GET(new Request("https://inbox.test/api/inbox/conversations/x/detail"), params)).status).toBe(404);
    expect((await POST(request({ boundaryId, batch: 0 }))).status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("refuses unsupported history cursors instead of silently returning page one", async () => {
    expect((await GET(new Request(`https://inbox.test/api/inbox/conversations/x/detail?orgId=${boundaryId}&before=old`), params)).status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("refuses cross-site mutations before creating a client", async () => {
    expect((await POST(request({ boundaryId, batch: 0 }, { origin: "https://foreign.test" }))).status).toBe(403);
    expect((await POST(request({ boundaryId, batch: 0 }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("bounds chunked bodies and rejects arbitrary revision/identity inputs", async () => {
    expect((await POST(request({ boundaryId, batch: 0, revision: "100" }))).status).toBe(400);
    expect((await POST(request({ boundaryId: "x".repeat(2048), batch: 0 }))).status).toBe(413);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("submits the stable boundary/batch and returns only its committed receipt without caching", async () => {
    const result = await POST(request({ boundaryId, batch: 0 }));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(await result.json()).toEqual({ boundaryId, batch: 0, changed: 1, completed: true });
    expect(mocks.rpc).toHaveBeenCalledWith("inbox_acknowledge_read", { boundary_id: boundaryId, batch_number: 0 });
  });
});
