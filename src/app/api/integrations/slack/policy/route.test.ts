import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  memberships: vi.fn(),
  list: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: mocks.memberships, MembershipLookupError: class MembershipLookupError extends Error {} }));
vi.mock("@/lib/integrations/slack/unfurl-store", () => ({ listSlackPreviewInstallations: mocks.list, setSlackPreviewPolicy: mocks.set }));

import { GET, POST } from "./route";

const INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000003";

function request(body?: unknown, url = `https://sandra.test/api/integrations/slack/policy?orgId=${ORG_ID}`) {
  return new Request(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: "owner-1" } } });
  mocks.memberships.mockResolvedValue([{ user_id: "owner-1", org_id: ORG_ID, role: "owner", access_status: "active" }]);
  mocks.list.mockResolvedValue([{ id: INSTALLATION_ID, teamName: "BMH", appId: "A123", status: "active", currentVersion: 2, policyMode: "legacy", policyEnabled: false, accountLinked: true }]);
  mocks.set.mockResolvedValue({ mode: "eligible_internal_channels", policyRevision: 2 });
});

describe("Slack preview policy route", () => {
  it("returns safe metadata and owner capability without tokens", async () => {
    const response = await GET(request(undefined));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ orgId: ORG_ID, canManage: true, installations: [{ id: INSTALLATION_ID, teamName: "BMH", appId: "A123", status: "active", currentVersion: 2, policyMode: "legacy", policyEnabled: false, accountLinked: true }] });
    expect(JSON.stringify(body)).not.toContain("token");
  });

  it("requires an active owner and explicit acknowledgement to enable", async () => {
    expect((await POST(request({ installationId: INSTALLATION_ID, orgId: ORG_ID, enabled: true }))).status).toBe(400);
    mocks.memberships.mockResolvedValue([{ user_id: "owner-1", org_id: ORG_ID, role: "member", access_status: "active" }]);
    expect((await POST(request({ installationId: INSTALLATION_ID, orgId: ORG_ID, enabled: false }))).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("updates the policy through the fenced service RPC", async () => {
    const response = await POST(request({ installationId: INSTALLATION_ID, orgId: ORG_ID, enabled: true, sharingPolicyAcknowledged: true }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, mode: "eligible_internal_channels", policyRevision: 2 });
    expect(mocks.set).toHaveBeenCalledWith({ installationId: INSTALLATION_ID, orgId: ORG_ID, ownerId: "owner-1", enabled: true });
  });

  it("denies a requested organization outside the caller membership", async () => {
    expect((await GET(request(undefined, `https://sandra.test/api/integrations/slack/policy?orgId=${OTHER_ORG_ID}`))).status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("does not guess a current organization when membership is ambiguous", async () => {
    mocks.memberships.mockResolvedValue([
      { user_id: "owner-1", org_id: ORG_ID, role: "owner", access_status: "active" },
      { user_id: "owner-1", org_id: OTHER_ORG_ID, role: "owner", access_status: "active" },
    ]);
    const response = await GET(request(undefined, "https://sandra.test/api/integrations/slack/policy"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ orgId: null, canManage: false, installations: [] });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("rejects JSON null and arrays as malformed policy requests", async () => {
    expect((await POST(request(null))).status).toBe(400);
    expect((await POST(request([]))).status).toBe(400);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
