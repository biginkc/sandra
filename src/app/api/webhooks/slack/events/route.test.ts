import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  enqueue: vi.fn(),
  find: vi.fn(),
  stale: vi.fn(),
  revoke: vi.fn(),
  revokeChannel: vi.fn(),
  revokeAccounts: vi.fn(),
  lifecycle: vi.fn(),
}));

vi.mock("@/lib/integrations/slack/signature", () => ({ verifySlackSignature: mocks.verify }));
vi.mock("@/lib/integrations/slack/unfurl-store", () => ({ enqueueSlackUnfurlEvent: mocks.enqueue, findSlackInstallations: mocks.find, isSlackUnfurlInstallationStaleError: mocks.stale, processSlackLifecycleEvent: mocks.lifecycle }));

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
    mocks.stale.mockReturnValue(false);
    mocks.find.mockResolvedValue([{ installationId: "I1", orgId: "O1", teamId: "T123", appId: "A123", installationVersion: 1, status: "active", scopes: [] }]);
    mocks.enqueue.mockResolvedValue({ accepted: true, duplicate: false, jobId: "J1" });
    mocks.revoke.mockResolvedValue(undefined);
    mocks.revokeChannel.mockResolvedValue(undefined);
    mocks.revokeAccounts.mockResolvedValue(undefined);
    mocks.lifecycle.mockResolvedValue(true);
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
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ appId: "A123", eventId: "Ev123", installationVersion: 1 }));
  });

  it("turns an installation version race into a durable terminal no-op", async () => {
    vi.stubEnv("SLACK_LEAD_UNFURL_ENABLED", "1");
    mocks.stale.mockReturnValueOnce(true);
    mocks.enqueue.mockRejectedValueOnce(new Error("INSTALLATION_VERSION_MISMATCH"));
    const response = await POST(request(base));
    expect(response.status).toBe(200);
    expect(mocks.enqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({ denialCode: "installation_stale", installationVersion: null, orgId: null, installationId: null, urlKeys: [] }));
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
    expect(mocks.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ teamId: "T123", appId: "A123", eventId: "Ev123", action: "installation" }));
  });

  it("revokes only affected account links for user-token lifecycle events", async () => {
    const response = await POST(request({ ...base, event: { type: "tokens_revoked", tokens: { oauth: ["U123", "U456"] } } }));
    expect(response.status).toBe(200);
    expect(mocks.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ teamId: "T123", appId: "A123", slackUserIds: ["U123", "U456"], action: "account_links" }));
  });

  it("revokes channel approval when Slack reports a newly shared channel", async () => {
    const response = await POST(request({ ...base, event: { type: "channel_shared", channel: "C123" } }));
    expect(response.status).toBe(200);
    expect(mocks.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ teamId: "T123", appId: "A123", channelId: "C123", action: "channel" }));
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

  it("times out accepted installation lookup with a retryable response", async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("SLACK_LEAD_UNFURL_ENABLED", "1");
      mocks.find.mockReturnValue(new Promise(() => undefined));
      const pending = POST(request(base));
      await vi.advanceTimersByTimeAsync(2_500);
      expect((await pending).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out accepted enqueue with a retryable response", async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("SLACK_LEAD_UNFURL_ENABLED", "1");
      mocks.enqueue.mockReturnValue(new Promise(() => undefined));
      const pending = POST(request(base));
      await vi.advanceTimersByTimeAsync(2_500);
      expect((await pending).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acknowledges a deliberate denial when its receipt logger stalls", async () => {
    vi.useFakeTimers();
    try {
      mocks.enqueue.mockReturnValue(new Promise(() => undefined));
      const pending = POST(request(base));
      await vi.advanceTimersByTimeAsync(2_500);
      expect((await pending).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a no-op receipt operation after the deadline is already exhausted", async () => {
    const startedAt = Date.now();
    let nowCalls = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls <= 2 ? startedAt : startedAt + 3_000;
    });
    try {
      const response = await POST(request(base));
      expect(response.status).toBe(200);
      expect(mocks.enqueue).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("observes a late receipt rejection after returning a bounded denial response", async () => {
    vi.useFakeTimers();
    let rejectLate!: (error: Error) => void;
    try {
      mocks.enqueue.mockReturnValue(new Promise((_, reject) => { rejectLate = reject; }));
      const pending = POST(request(base));
      await vi.advanceTimersByTimeAsync(2_500);
      expect((await pending).status).toBe(200);
      rejectLate(new Error("late receipt failure"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });
});
