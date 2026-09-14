import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), page: vi.fn(), unknown: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: mocks.user } }) }));
vi.mock("@/lib/messages/list-threads", () => ({ listThreadPage: mocks.page }));
vi.mock("@/lib/messages/list-unknown-senders", () => ({ listUnknownSenders: mocks.unknown }));
import { GET } from "./route";
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ data: { user: { id: "viewer" } } });
  mocks.page.mockResolvedValue({ threads: [], counts: { all: 5 }, page: 1 });
  mocks.unknown.mockResolvedValue([{ isDismissed: false }, { isDismissed: true }, { isDismissed: false }]);
});
it("returns existing exact thread and unknown counts with the authenticated viewer scope", async () => {
  const response = await GET(new Request("https://example.test/api/messages/inbox-refresh?filter=all&userId=attacker"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ page: { threads: [], counts: { all: 5 }, page: 1 }, unknown: 2, dismissed: 1 });
  expect(mocks.page.mock.calls[0][1]).toEqual(expect.objectContaining({ currentUserId: "viewer", filter: "all" }));
  expect(mocks.unknown.mock.calls[0][1]).toEqual({ includeDismissed: true });
});
it("does not read inbox data without authentication", async () => {
  mocks.user.mockResolvedValue({ data: { user: null } });
  const response = await GET(new Request("https://example.test/api/messages/inbox-refresh"));
  expect(response.status).toBe(401); expect(mocks.page).not.toHaveBeenCalled(); expect(mocks.unknown).not.toHaveBeenCalled();
});
it("does not replace old counts with partial success", async () => {
  mocks.unknown.mockRejectedValue(new Error("private provider details"));
  const response = await GET(new Request("https://example.test/api/messages/inbox-refresh"));
  expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).not.toContain("private provider details");
});
it("rejects invalid selected IDs before reads", async () => {
  expect((await GET(new Request("https://example.test/api/messages/inbox-refresh?thread=bad"))).status).toBe(400);
  expect(mocks.page).not.toHaveBeenCalled();
});
