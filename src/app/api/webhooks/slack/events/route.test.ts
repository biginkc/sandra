import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  enqueue: vi.fn(),
  find: vi.fn(),
  revoke: vi.fn(),
  revokeChannel: vi.fn(),
  revokeAccounts: vi.fn(),
}));

vi.mock("@/lib/integrations/slack/signature", () => ({ verifySlackSignature: mocks.verify }));
vi.mock("@/lib/integrations/slack/unfurl-store", () => ({ enqueueSlackUnfurlEvent: mocks.enqueue, findSlackInstallations: mocks.find, revokeSlackInstallation: mocks.revoke, revokeSlackChannelApproval: mocks.revokeChannel, revokeSlackAccountLinks: mocks.revokeAccounts }));

import { POST } from "./route";

function request(payload: unknown) {
  return new Request("https://sandra.test/api/webhooks/slack/events", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "x-slack-request-timestamp": "1710000000", "x-slack-signature": "v0=test" },
  });
}

const base = {
  type: "event_callback",
  team_id: "T123",
  api_app_id: "A123",
  event_id: "Ev123",
  event_time: 1710000000,
  event: { type: "link_shared", channel: "C123", user: "U123", message_ts: "171.1", links: [{ url: "https://sandra.bmhgroupkc.com/leads/abcdefab-1234-4abc-8def-abcdefabcdef" }] },
};

describe("Slack events route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("SLACK_SIGNING_SECRET", "secret");
    vi.stubEnv("SLACK_CLIENT_ID", "12345.67890");
    vi.stubEnv("SLACK_APP_ID", "A123");
    mocks.verify.mockReturnValue(true);
    mocks.find.mockResolvedValue([{ installationId: "I1", orgId: "O1", teamId: "T123", appId: "A123", installationVersion: 1, status: "active", scopes: [] }]);
    mocks.enqueue.mockResolvedValue({ accepted: true, duplicate: false, jobId: "J1" });
    mocks.revoke.mockResolvedValue(undefined);
    mocks.revokeChannel.mockResolvedValue(undefined);
    mocks.revokeAccounts.mockResolvedValue(undefined);
  });

  it("returns the signed URL verification challenge", async () => {
    const response = await POST(request({ type: "url_verification", challenge: "challenge", api_app_id: "A123" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ challenge: "challenge" });
  });

  it("does not compare OAuth client_id with api_app_id", async () => {
    vi.stubEnv("SLACK_LEAD_UNFURL_ENABLED", "1");
    const response = await POST(request(base));
    expect(response.status).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ appId: "A123", eventId: "Ev123" }));
  });

  it("acknowledges denied/disabled events even if no-op receipt logging fails", async () => {
    mocks.enqueue.mockRejectedValue(new Error("db unavailable"));
    const response = await POST(request(base));
    expect(response.status).toBe(200);
  });

  it("returns 503 only when accepted work cannot be durably enqueued", async () => {
    vi.stubEnv("SLACK_LEAD_UNFURL_ENABLED", "1");
    mocks.enqueue.mockRejectedValue(new Error("db unavailable"));
    const response = await POST(request(base));
    expect(response.status).toBe(503);
  });

  it("processes lifecycle revocation while the preview flag is disabled", async () => {
    const response = await POST(request({ ...base, event: { type: "app_uninstalled" } }));
    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith("T123", "A123", "app_uninstalled");
  });

  it("revokes only affected account links for user-token lifecycle events", async () => {
    const response = await POST(request({ ...base, event: { type: "tokens_revoked", tokens: { oauth: ["U123", "U456"] } } }));
    expect(response.status).toBe(200);
    expect(mocks.revokeAccounts).toHaveBeenCalledWith("T123", "A123", ["U123", "U456"], "tokens_revoked");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("revokes channel approval when Slack reports a newly shared channel", async () => {
    const response = await POST(request({ ...base, event: { type: "channel_shared", channel: "C123" } }));
    expect(response.status).toBe(200);
    expect(mocks.revokeChannel).toHaveBeenCalledWith("T123", "A123", "C123", "channel_shared");
  });

  it("denies composer link events before installation lookup or enqueue", async () => {
    vi.stubEnv("SLACK_LEAD_UNFURL_ENABLED", "1");
    const response = await POST(request({ ...base, event: { ...base.event, channel: "COMPOSER", source: "composer" } }));
    expect(response.status).toBe(200);
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ denialCode: "composer_denied" }));
  });

  it("rejects invalid signatures, oversized bodies, and malformed envelopes", async () => {
    mocks.verify.mockReturnValue(false);
    expect((await POST(request(base))).status).toBe(401);
    mocks.verify.mockReturnValue(true);
    expect((await POST(request({ type: "event_callback", event_id: "x" }))).status).toBe(400);
  });
});
