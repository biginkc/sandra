import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), fetchDetail: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/app/(dashboard)/messages/inbox-detail-data", () => ({ fetchInboxDetail: mocks.fetchDetail }));
import { GET } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const request = () => new Request(`https://sandra.example/api/messages/thread-detail?thread=${id}`);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: "viewer" } } });
});
describe("conversation detail endpoint", () => {
  it("rejects invalid identifiers before querying", async () => {
    expect((await GET(new Request("https://sandra.example/api/messages/thread-detail?thread=no"))).status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("requires an authenticated viewer", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    expect((await GET(request())).status).toBe(401);
    expect(mocks.fetchDetail).not.toHaveBeenCalled();
  });
  it("uses the session client and returns private uncached detail", async () => {
    mocks.fetchDetail.mockResolvedValue({ threadId: id });
    const response = await GET(request());
    expect(await response.json()).toEqual({ detail: { threadId: id } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.fetchDetail).toHaveBeenCalledWith(await mocks.createClient(), id);
  });
  it("does not disclose inaccessible conversations or internal errors", async () => {
    mocks.fetchDetail.mockResolvedValue(null);
    expect(await (await GET(request())).json()).toEqual({ detail: null });
    mocks.fetchDetail.mockRejectedValue(new Error("private database detail"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private database");
  });
});
