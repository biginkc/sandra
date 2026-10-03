import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  memberships: vi.fn(),
  list: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: mocks.memberships }));
vi.mock("@/lib/integrations/slack/unfurl-store", () => ({ listSlackPreviewInstallations: mocks.list, setSlackPreviewPolicy: mocks.set }));

import { GET, POST } from "./route";

function request(body?: unknown, url = "https://sandra.test/api/integrations/slack/policy?orgId=org-1") {
  return new Request(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: "owner-1" } } });
  mocks.memberships.mockResolvedValue([{ user_id: "owner-1", org_id: "org-1", role: "owner", access_status: "active" }]);
  mocks.list.mockResolvedValue([{ id: "installation-1", teamName: "BMH", appId: "A123", status: "active", currentVersion: 2, policyEnabled: false, accountLinked: true }]);
  mocks.set.mockResolvedValue({ mode: "eligible_internal_channels", policyRevision: 2 });
});

describe("Slack preview policy route", () => {
  it("returns safe metadata and owner capability without tokens", async () => {
    const response = await GET(request(undefined));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ orgId: "org-1", canManage: true, installations: [{ id: "installation-1", teamName: "BMH", appId: "A123", status: "active", currentVersion: 2, policyEnabled: false, accountLinked: true }] });
    expect(JSON.stringify(body)).not.toContain("token");
  });

  it("requires an active owner and explicit acknowledgement to enable", async () => {
    expect((await POST(request({ installationId: "installation-1", orgId: "org-1", enabled: true }))).status).toBe(400);
    mocks.memberships.mockResolvedValue([{ user_id: "owner-1", org_id: "org-1", role: "member", access_status: "active" }]);
    expect((await POST(request({ installationId: "installation-1", orgId: "org-1", enabled: false }))).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("updates the policy through the fenced service RPC", async () => {
    const response = await POST(request({ installationId: "installation-1", orgId: "org-1", enabled: true, sharingPolicyAcknowledged: true }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, mode: "eligible_internal_channels", policyRevision: 2 });
    expect(mocks.set).toHaveBeenCalledWith({ installationId: "installation-1", orgId: "org-1", ownerId: "owner-1", enabled: true });
  });

  it("denies a requested organization outside the caller membership", async () => {
    expect((await GET(request(undefined, "https://sandra.test/api/integrations/slack/policy?orgId=org-2"))).status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
