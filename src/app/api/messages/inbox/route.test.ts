import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), list: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/messages/list-threads", () => ({ listThreadPage: mocks.list }));
import { GET } from "./route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: "viewer" } } });
  mocks.list.mockResolvedValue({ threads: [], counts: { all: 0 }, page: 1 });
});
it("authenticates before reading the snapshot and never accepts caller-supplied identity", async () => {
  const response = await GET(new Request("https://sandra.test/api/messages/inbox?filter=mine&currentUserId=foreign&orgId=foreign&inboxPage=-1"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith(await mocks.createClient(), expect.objectContaining({ filter: "mine", currentUserId: "viewer", page: 1 }));
  expect(mocks.getUser.mock.invocationCallOrder[0]).toBeLessThan(mocks.list.mock.invocationCallOrder[0]);
});
it("does not query for unauthenticated callers", async () => {
  mocks.getUser.mockResolvedValue({ data: { user: null } });
  const response = await GET(new Request("https://sandra.test/api/messages/inbox"));
  expect(response.status).toBe(401);
  expect(mocks.list).not.toHaveBeenCalled();
});
it("returns rows/counts from one call and retains selected-thread and search semantics", async () => {
  const thread = "11111111-1111-4111-8111-111111111111";
  const response = await GET(new Request(`https://sandra.test/api/messages/inbox?thread=${thread}&filter=unread&hideDnc=0&search=hello`));
  expect(await response.json()).toEqual({ page: { threads: [], counts: { all: 0 }, page: 1 } });
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith(await mocks.createClient(), expect.objectContaining({ includeThreadId: thread, filter: "unread", hideNoise: false, search: "hello" }));
});
it("bounds search and excludes internal error content", async () => {
  mocks.list.mockRejectedValue(new Error("private credentials"));
  const response = await GET(new Request(`https://sandra.test/api/messages/inbox?search=${"a".repeat(150)}`));
  expect(mocks.list.mock.calls[0][1].search).toHaveLength(100);
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain("credentials");
});
