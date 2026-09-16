import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), rpc: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
import { GET } from "@/app/api/inbox/conversations/[conversationId]/detail/route";
import { POST } from "@/app/api/inbox/read-acknowledgments/route";
const boundaryId = "33333333-3333-3333-3333-333333333333";
const pilotUserId = "44444444-4444-4444-4444-444444444444";
const params = { params: Promise.resolve({ conversationId: boundaryId }) };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://inbox.test/api/inbox/read-acknowledgments", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
  // GL-4/G5: pilot cohort allowlist — both routes now resolve the caller's
  // id via Supabase Auth (not an inbox_* RPC) before any RPC runs.
  vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", pilotUserId);
  mocks.createClient.mockResolvedValue({ rpc: mocks.rpc, auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: pilotUserId } } });
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
  it("refuses malformed history cursors instead of silently returning page one", async () => {
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
  it("denies a user outside the pilot cohort for both routes without calling their RPC (GL-4/G5)", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "not-piloted-user" } } });
    expect((await GET(new Request(`https://inbox.test/api/inbox/conversations/x/detail?orgId=${boundaryId}`), params)).status).toBe(404);
    expect((await POST(request({ boundaryId, batch: 0 }))).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  // MUTATION: removing the pilot check from either route.ts makes this fail —
  // an out-of-cohort user would reach inbox_acknowledge_read / the detail RPC.
});
