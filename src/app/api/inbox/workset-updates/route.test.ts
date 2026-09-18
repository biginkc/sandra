import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  getUser: vi.fn(),
  memberships: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.create }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: mocks.memberships }));
vi.mock("@/lib/inbox/workset-updates", () => ({ probeInboxWorksetUpdates: mocks.probe }));

import { GET } from "./route";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const request = () => new Request(`https://example.com/api/inbox/workset-updates?scopeId=${id}`);
const response = { scopeId: id, orgId: id, requesterId: id, sessionId: id, accessEpoch: "1", generation: "2", hasUpdates: false, refreshRequired: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
  vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", id);
  vi.stubEnv("INBOX_WORKSPACE_ROLLOUT_MODE", "all");
  mocks.create.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id } } });
  mocks.memberships.mockResolvedValue([{ user_id: id, org_id: id, role: "owner", acquisitions_enabled: false, access_status: "active" }]);
  mocks.probe.mockResolvedValue(response);
});

afterEach(() => vi.unstubAllEnvs());

describe("workset update route access boundary", () => {
  it("returns the identity-bound probe for an admitted shared-workspace member", async () => {
    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(response);
    expect(mocks.probe).toHaveBeenCalledWith(expect.anything(), id, expect.any(AbortSignal));
  });

  it("returns 404 and never probes for an acquisitions-only member", async () => {
    mocks.memberships.mockResolvedValue([{ user_id: id, org_id: id, role: "member", acquisitions_enabled: true, access_status: "active" }]);
    const result = await GET(request());
    expect(result.status).toBe(404);
    expect(mocks.probe).not.toHaveBeenCalled();
  });
});
