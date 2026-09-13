import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
const mocks = vi.hoisted(() => ({ create: vi.fn(), getUser: vi.fn(), membership: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.create }));
vi.mock("@/lib/auth/memberships", () => ({ getSingleActiveMembership: mocks.membership }));
vi.mock("@/lib/inbox-v2/read-detail", () => ({ readInboxDetail: mocks.read }));
const id = "123e4567-e89b-12d3-a456-426614174000";
const request = (suffix = "") => new Request(`http://localhost/api/inbox-v2/detail?conversationId=${id}${suffix}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INBOX_V2_EXPERIMENT_ENABLED", "1");
  mocks.create.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: "member" } }, error: null });
  mocks.membership.mockResolvedValue({ ok: true, membership: { user_id: "member", org_id: "org" } });
  mocks.read.mockResolvedValue({ status: "ready", conversationId: id, messages: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe("flagged Inbox detail GET", () => {
  it("defaults closed before creating any client", async () => {
    vi.stubEnv("INBOX_V2_EXPERIMENT_ENABLED", undefined);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["&orgId=foreign", "&cursor=bad", "&pageSize=101", "&pageSize=", `&conversationId=${id}`])("rejects malformed request %s before reads", async suffix => {
    expect((await GET(request(suffix))).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires authenticated user and matching unambiguous membership", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await GET(request())).status).toBe(401);
    expect(mocks.membership).not.toHaveBeenCalled();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "member" } }, error: null });
    mocks.membership.mockResolvedValue({ ok: false, reason: "ambiguous" });
    expect((await GET(request())).status).toBe(403);
    mocks.membership.mockResolvedValue({ ok: true, membership: { user_id: "someone-else", org_id: "org" } });
    expect((await GET(request())).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("passes session organization and validated limit, with private no-store success", async () => {
    const response = await GET(request("&pageSize=25"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.read).toHaveBeenCalledWith(expect.anything(), "org", { conversationId: id, pageSize: 25, before: null });
  });
  it("does not reveal foreign existence or exception payloads", async () => {
    mocks.read.mockResolvedValue({ status: "unavailable", conversationId: id });
    expect((await GET(request())).status).toBe(404);
    mocks.read.mockRejectedValue(new Error("Private body and SQL password"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Conversation unavailable" });
  });
});
