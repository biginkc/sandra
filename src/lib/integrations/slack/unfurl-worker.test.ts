import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  claim: vi.fn(),
  installation: vi.fn(),
  link: vi.fn(),
  membership: vi.fn(),
  approval: vi.fn(),
  verify: vi.fn(),
  urls: vi.fn(),
  updateUrl: vi.fn(),
  finish: vi.fn(),
  reschedule: vi.fn(),
  release: vi.fn(),
  loadData: vi.fn(),
  blocks: vi.fn(),
  unfurl: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@slack/web-api", () => ({ WebClient: vi.fn(function MockWebClient() { return { chat: { unfurl: mocks.unfurl } }; }) }));
vi.mock("./unfurl-store", () => ({
  cleanupSlackUnfurlData: mocks.cleanup,
  claimSlackUnfurlJobs: mocks.claim,
  loadSlackInstallation: mocks.installation,
  loadSlackAccountLink: mocks.link,
  hasActiveSlackMembership: mocks.membership,
  loadSlackChannelApproval: mocks.approval,
  loadSlackJobUrls: mocks.urls,
  updateSlackJobUrl: mocks.updateUrl,
  finishSlackUnfurlJob: mocks.finish,
  rescheduleSlackUnfurlJob: mocks.reschedule,
  releaseSlackUnfurlJobClaim: mocks.release,
}));
vi.mock("./unfurl-policy", () => ({
  parseSlackLeadUrl: vi.fn((url: string) => ({ ok: true, link: { originalUrl: url, propertyId: "11111111-1111-4111-8111-111111111111", kind: "lead" } })),
  verifySlackDestination: mocks.verify,
}));
vi.mock("./unfurl-data", () => ({ loadPreviewData: mocks.loadData }));
vi.mock("./unfurl-blocks", () => ({ buildPreviewBlocks: mocks.blocks }));

import { runSlackUnfurlSweep } from "./unfurl-worker";

const now = Date.now();
const job = {
  id: "job-1",
  receipt_id: "receipt-1",
  installation_id: "installation-1",
  installation_version: 1,
  org_id: "org-1",
  team_id: "T123",
  app_id: "A123",
  channel_id: "C123",
  message_ts: "171.1",
  poster_slack_user_id: "U123",
  event_time: new Date(now).toISOString(),
  status: "processing",
  attempts: 1,
  max_attempts: 5,
  next_attempt_at: new Date(now).toISOString(),
  lease_expires_at: new Date(now + 90_000).toISOString(),
  claim_token: "claim-1",
  last_error_code: null,
  expires_at: new Date(now + 15 * 60_000).toISOString(),
  created_at: new Date(now).toISOString(),
  updated_at: new Date(now).toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SLACK_LEAD_UNFURL_ENABLED", "1");
  mocks.cleanup.mockResolvedValue(0);
  mocks.claim.mockResolvedValue([{ ...job }]);
  mocks.installation.mockResolvedValue({
    installationId: "installation-1", orgId: "org-1", teamId: "T123", appId: "A123", teamName: "BMH", botUserId: "B123", botToken: { reveal: () => "xoxb-secret" }, scopes: ["links:read", "links:write", "channels:read", "groups:read", "users:read"], installationVersion: 1, status: "active",
  });
  mocks.link.mockResolvedValue({ userId: "sandra-user-1", status: "active" });
  mocks.membership.mockResolvedValue(true);
  mocks.approval.mockResolvedValue({ installationId: "installation-1", orgId: "org-1", channelId: "C123", status: "active", sharingPolicyAcknowledged: true });
  mocks.verify.mockResolvedValue({ allowed: true, channel: { id: "C123" }, user: { id: "U123" } });
  mocks.urls.mockResolvedValue([
    { url_key: "https://sandra.bmhgroupkc.com/leads/11111111-1111-4111-8111-111111111111", lead_id: null, lookup_status: null, authorization_status: null, last_error_code: null },
    { url_key: "https://sandra.bmhgroupkc.com/my-leads?lead=22222222-2222-4222-8222-222222222222", lead_id: null, lookup_status: null, authorization_status: null, last_error_code: null },
  ]);
  mocks.loadData.mockResolvedValue({ propertyId: "11111111-1111-4111-8111-111111111111", leadName: "Lead", address: "1 Main", ownerName: null, ownerAssigned: false, latestAttempt: null, messagesDisposition: null, lastContactAt: null, timezone: "America/Chicago", messages: [] });
  mocks.blocks.mockReturnValue([{ type: "section", text: { type: "mrkdwn", text: "Lead" } }]);
  mocks.unfurl.mockResolvedValue({ ok: true });
  mocks.finish.mockResolvedValue(true);
  mocks.reschedule.mockResolvedValue(true);
  mocks.release.mockResolvedValue(true);
});

describe("Slack unfurl worker", () => {
  it("renders the complete eligible URL map in one chat.unfurl call", async () => {
    const result = await runSlackUnfurlSweep();
    expect(result.succeeded).toBe(1);
    expect(mocks.unfurl).toHaveBeenCalledTimes(1);
    expect(Object.keys(mocks.unfurl.mock.calls[0][0].unfurls)).toHaveLength(2);
    expect(mocks.finish).toHaveBeenCalledWith({ jobId: "job-1", claimToken: "claim-1", status: "succeeded" });
  });

  it("respects Retry-After values above the exponential backoff cap", async () => {
    mocks.unfurl.mockRejectedValueOnce({ code: "slack_webapi_rate_limited_error", retryAfter: 600 });
    await runSlackUnfurlSweep();
    const call = mocks.reschedule.mock.calls[0][0] as { nextAttemptAt: Date };
    expect(call.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(now + 600_000 - 1_000);
  });

  it("retries after Slack success when durable completion fails", async () => {
    mocks.finish.mockRejectedValueOnce(new Error("completion write failed"));
    await runSlackUnfurlSweep();
    expect(mocks.unfurl).toHaveBeenCalledTimes(1);
    expect(mocks.reschedule).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", claimToken: "claim-1", errorCode: "slack_unfurl_failed" }));
  });

  it("still cleans retention data while the feature flag is disabled", async () => {
    vi.stubEnv("SLACK_LEAD_UNFURL_ENABLED", "0");
    const result = await runSlackUnfurlSweep();
    expect(result.cleaned).toBe(0);
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.unfurl).not.toHaveBeenCalled();
  });

  it("revalidates current membership before any private lead read", async () => {
    mocks.membership.mockResolvedValue(false);
    const result = await runSlackUnfurlSweep();
    expect(result.noops).toBe(1);
    expect(mocks.loadData).not.toHaveBeenCalled();
    expect(mocks.unfurl).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith({ jobId: "job-1", claimToken: "claim-1", status: "noop", errorCode: "poster_membership_inactive" });
  });

  it("rechecks Slack destination authority on each recovered attempt", async () => {
    await runSlackUnfurlSweep();
    mocks.claim.mockResolvedValue([{ ...job, attempts: 2 }]);
    mocks.verify.mockResolvedValue({ allowed: false, reason: "channel_sharing_denied" });
    await runSlackUnfurlSweep();
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.unfurl).toHaveBeenCalledTimes(1);
    expect(mocks.finish).toHaveBeenLastCalledWith({ jobId: "job-1", claimToken: "claim-1", status: "noop", errorCode: "channel_sharing_denied" });
  });

  it("cancels permanently revoked Slack identities without retrying", async () => {
    mocks.verify.mockResolvedValue({ allowed: false, reason: "installation_revoked" });
    const result = await runSlackUnfurlSweep();
    expect(result.noops).toBe(1);
    expect(mocks.reschedule).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith({ jobId: "job-1", claimToken: "claim-1", status: "cancelled", errorCode: "installation_revoked" });
  });

  it("cancels a job from an older installation generation", async () => {
    mocks.installation.mockResolvedValue({
      installationId: "installation-1", orgId: "org-1", teamId: "T123", appId: "A123", teamName: "BMH", botUserId: "B123", botToken: { reveal: () => "xoxb-secret" }, scopes: ["links:read", "links:write", "channels:read", "groups:read", "users:read"], installationVersion: 2, status: "active",
    });
    const result = await runSlackUnfurlSweep();
    expect(result.noops).toBe(1);
    expect(mocks.finish).toHaveBeenCalledWith({ jobId: "job-1", claimToken: "claim-1", status: "noop", errorCode: "installation_unavailable" });
    expect(mocks.loadData).not.toHaveBeenCalled();
  });

  it("retries transient Slack authority outages before reading private lead data", async () => {
    mocks.verify.mockResolvedValue({ allowed: false, reason: "slack_authority_unavailable", retryAfterSeconds: 600 });
    const result = await runSlackUnfurlSweep();

    expect(result.retried).toBe(1);
    expect(mocks.loadData).not.toHaveBeenCalled();
    expect(mocks.unfurl).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.reschedule).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      claimToken: "claim-1",
      errorCode: "slack_authority_unavailable",
    }));
    const retry = mocks.reschedule.mock.calls[0][0] as { nextAttemptAt: Date };
    expect(retry.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(now + 600_000 - 1_000);
  });

  it("releases claims it cannot start before the worker deadline", async () => {
    const second = { ...job, id: "job-2", claim_token: "claim-2" };
    mocks.claim.mockResolvedValue([job, second]);
    let clock = Date.now();
    const clockSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    mocks.finish.mockImplementationOnce(async () => {
      clock += 46_000;
      return true;
    });

    try {
      const result = await runSlackUnfurlSweep();
      expect(result.succeeded).toBe(1);
      expect(mocks.release).toHaveBeenCalledWith({ jobId: "job-2", claimToken: "claim-2" });
    } finally {
      clockSpy.mockRestore();
    }
  });
});
