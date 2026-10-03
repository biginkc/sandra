import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  memberships: vi.fn(),
  loadInstallation: vi.fn(),
  verifyChannel: vi.fn(),
  approve: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: mocks.memberships }));
vi.mock("@/lib/integrations/slack/unfurl-store", () => ({
  loadSlackInstallationById: mocks.loadInstallation,
  approveSlackChannel: mocks.approve,
}));
vi.mock("@/lib/integrations/slack/unfurl-policy", () => ({ verifySlackChannelForApproval: mocks.verifyChannel }));

import { POST } from "./route";

const installation = {
  installationId: "installation-1",
  orgId: "org-1",
  teamId: "T123",
  appId: "A123",
  teamName: "BMH",
  botUserId: "B123",
  botToken: { reveal: () => "xoxb-secret" },
  scopes: ["channels:read"],
  installationVersion: 1,
  status: "active" as const,
};

function request(body: unknown) {
  return new Request("https://sandra.test/api/integrations/slack/channels/approve", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const validBody = {
  installationId: "installation-1",
  orgId: "org-1",
  channelId: "C123",
  sharingPolicyAcknowledged: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.memberships.mockResolvedValue([{ user_id: "user-1", org_id: "org-1", role: "owner", access_status: "active" }]);
  mocks.loadInstallation.mockResolvedValue(installation);
  mocks.verifyChannel.mockResolvedValue({ allowed: true, channel: { id: "C123" } });
  mocks.approve.mockResolvedValue("approval-1");
});

describe("Slack channel approval route", () => {
  it("requires a signed-in operator and explicit policy acknowledgement", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    expect((await POST(request(validBody))).status).toBe(401);

    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    expect((await POST(request({ ...validBody, sharingPolicyAcknowledged: false }))).status).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("requires organization membership and a live approved channel", async () => {
    mocks.memberships.mockResolvedValue([]);
    expect((await POST(request(validBody))).status).toBe(403);

    mocks.memberships.mockResolvedValue([{ user_id: "user-1", org_id: "org-1", role: "member", access_status: "active" }]);
    mocks.verifyChannel.mockResolvedValue({ allowed: false, reason: "channel_sharing_denied" });
    expect((await POST(request(validBody))).status).toBe(403);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("denies an active member because approval authorizes channel-wide disclosure", async () => {
    mocks.memberships.mockResolvedValue([{ user_id: "user-1", org_id: "org-1", role: "member", access_status: "active" }]);
    expect((await POST(request(validBody))).status).toBe(403);
    expect(mocks.verifyChannel).not.toHaveBeenCalled();
  });

  it("denies an admin because only the owner may authorize channel-wide disclosure", async () => {
    mocks.memberships.mockResolvedValue([{ user_id: "user-1", org_id: "org-1", role: "admin", access_status: "active" }]);
    expect((await POST(request(validBody))).status).toBe(403);
    expect(mocks.verifyChannel).not.toHaveBeenCalled();
  });

  it("persists only after live Slack verification", async () => {
    const response = await POST(request(validBody));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, approvalId: "approval-1" });
    expect(mocks.verifyChannel).toHaveBeenCalledWith({ token: "xoxb-secret", teamId: "T123", channelId: "C123" });
    expect(mocks.approve).toHaveBeenCalledWith({ installationId: "installation-1", orgId: "org-1", channelId: "C123", approvedBy: "user-1", sharingPolicyAcknowledged: true });
  });

  it("denies an owner when live Slack authority rejects the channel", async () => {
    mocks.verifyChannel.mockResolvedValue({ allowed: false, reason: "channel_sharing_denied" });
    const response = await POST(request(validBody));
    expect(response.status).toBe(403);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("returns 503 without exposing provider or database details", async () => {
    mocks.loadInstallation.mockRejectedValue(new Error("encrypted token unavailable"));
    const response = await POST(request(validBody));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("encrypted token");
  });
});
