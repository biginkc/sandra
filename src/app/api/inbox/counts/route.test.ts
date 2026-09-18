import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
const mocks = vi.hoisted(() => ({ create: vi.fn(), rpc: vi.fn(), getUser: vi.fn(), memberships: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.create }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: mocks.memberships }));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const authority = { user_id: id, session_id: id, org_id: id, access_epoch: "1", expires_at: "2030-01-01T00:00:00Z", session_active: true, active_membership_count: 1 };
const counts = { all: 3, mine: 1, unassigned: 2, unread: 1, escalated: 0, dispo: 0, needs_outcome: 0, unknown: 0, dismissed: 0 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ rpc: mocks.rpc, auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id } } });
  mocks.memberships.mockResolvedValue([{ user_id: id, org_id: id, role: "owner", acquisitions_enabled: false, access_status: "active" }]);
  vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", id);
});
afterEach(() => vi.unstubAllEnvs());
const request = (query = `orgId=${id}&view=all`) => new Request(`https://example.com/api/inbox/counts?${query}`);
describe("independent Inbox counts route", () => {
  it("defaults closed before client creation", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", undefined);
    expect((await GET(request())).status).toBe(404); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns 404 and never calls the counts RPC for a user outside the pilot allowlist (GL-4/G5)", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    mocks.getUser.mockResolvedValue({ data: { user: { id: "not-piloted-user" } } });
    expect((await GET(request())).status).toBe(404); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("returns 404 and never calls the counts RPC for an acquisitions-only member", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_WORKSPACE_ROLLOUT_MODE", "all");
    mocks.memberships.mockResolvedValue([{ user_id: id, org_id: id, role: "member", acquisitions_enabled: true, access_status: "active" }]);
    expect((await GET(request())).status).toBe(404); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  // MUTATION: removing the pilot check in route.ts makes this fail — the
  // out-of-cohort user would reach inbox_counts_v2 and get 200.
  it("returns 404 when the allowlist is empty (default = nobody)", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", undefined);
    expect((await GET(request())).status).toBe(404); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("uses actual repository with independent counts RPC and exposes unknown freshness honestly", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    mocks.rpc.mockImplementation((name: string) => ({ abortSignal: () => Promise.resolve({ data: name === "inbox_counts_v2" ? { counts, as_of: "2026-09-13T00:00:00Z", access_epoch: "1" } : authority, error: null }) }));
    const response = await GET(request(`orgId=${id}&view=all&hide_noise=false&search=Smith`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ counts, asOf: "2026-09-13T00:00:00Z", accessEpoch: "1", updating: null });
    expect(mocks.rpc).toHaveBeenCalledWith("inbox_counts_v2", { org_id: id, filter: { view: "all", hide_noise: false, search: "Smith" } });
    expect(mocks.rpc.mock.calls.every(([name]) => !String(name).includes("workset"))).toBe(true);
  });
  it.each([`orgId=${id}&view=all&view=mine`, `orgId=${id}&view=all&hide_noise=no`, `orgId=${id}&view=all&userId=other`, "orgId=invalid&view=all"])("denies malformed filter %s before RPC", async query => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
    expect((await GET(request(query))).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("discards counts if access epoch changes during the query", async () => {
    vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); let epoch = "1";
    mocks.rpc.mockImplementation((name: string) => ({ abortSignal: () => {
      if (name === "inbox_counts_v2") { epoch = "2"; return Promise.resolve({ data: { counts, as_of: "2026-09-13T00:00:00Z", access_epoch: "1" }, error: null }); }
      return Promise.resolve({ data: { ...authority, access_epoch: epoch }, error: null });
    } }));
    const response = await GET(request()); expect(response.status).toBe(403); expect(await response.text()).not.toContain('"all":3');
  });
});
