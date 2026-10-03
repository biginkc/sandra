import { describe, expect, it, vi } from "vitest";

const slack = vi.hoisted(() => ({
  channelInfo: vi.fn(),
  userInfo: vi.fn(),
}));

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn(function MockWebClient() {
    return { conversations: { info: slack.channelInfo }, users: { info: slack.userInfo } };
  }),
}));

import {
  authorizeSlackDestination,
  buildSlackLeadDeepLink,
  parseSlackLeadLinks,
  parseSlackLeadUrl,
  verifySlackDestination,
} from "./unfurl-policy";

const id = "ABCDEFAB-1234-4abc-8def-ABCDEFABCDEF";

describe("slack unfurl policy", () => {
  it("accepts canonical lead and My Leads URLs while ignoring unrelated query/fragment data", () => {
    expect(parseSlackLeadUrl(`https://sandra.bmhgroupkc.com/leads/${id}?utm=ignored#fragment`)).toMatchObject({ ok: true, link: { propertyId: id.toLowerCase() } });
    expect(parseSlackLeadUrl(`https://sandra.bmhgroupkc.com/my-leads?utm=ignored&lead=${id}#fragment`)).toMatchObject({ ok: true, link: { propertyId: id.toLowerCase() } });
    expect(buildSlackLeadDeepLink(id)).toBe(`https://sandra.bmhgroupkc.com/my-leads?lead=${id.toLowerCase()}`);
  });

  it("rejects deceptive hosts, userinfo, explicit ports, duplicate lead values, and invalid paths", () => {
    for (const url of [
      `https://sandra.bmhgroupkc.com.evil.test/leads/${id}`,
      `https://sandra.bmhgroupkc.com@evil.test/leads/${id}`,
      `https://sandra.bmhgroupkc.com:443/leads/${id}`,
      `https://sandra.bmhgroupkc.com/my-leads?lead=${id}&lead=${id}`,
      `https://sandra.bmhgroupkc.com/my-leads?lead=bad`,
      `https://sandra.bmhgroupkc.com/leads/${id}/extra`,
    ]) expect(parseSlackLeadUrl(url).ok).toBe(false);
  });

  it("caps events before accepting any link", () => {
    const result = parseSlackLeadLinks(Array.from({ length: 6 }, () => `https://sandra.bmhgroupkc.com/leads/${id}`));
    expect(result).toMatchObject({ overLimit: true, links: [] });
  });

  it("requires approved internal channel authority and accepts Slack's context_team_id shape", () => {
    const allowed = authorizeSlackDestination({
      approval: { installationId: "i", orgId: "o", channelId: "C", status: "active", sharingPolicyAcknowledged: true },
      expectedInstallationId: "i", expectedOrgId: "o", expectedTeamId: "T", expectedChannelId: "C", expectedPosterUserId: "U",
      channel: { id: "C", context_team_id: "T", shared_team_ids: ["T"], is_channel: true, is_member: true },
      user: { id: "U", team_id: "T", deleted: false, is_bot: false },
    });
    expect(allowed.allowed).toBe(true);
    const shared = authorizeSlackDestination({
      approval: { installationId: "i", orgId: "o", channelId: "C", status: "active", sharingPolicyAcknowledged: true },
      expectedInstallationId: "i", expectedOrgId: "o", expectedTeamId: "T", expectedChannelId: "C", expectedPosterUserId: "U",
      channel: { id: "C", context_team_id: "T", shared_team_ids: ["T2"], is_channel: true, is_member: true },
      user: { id: "U", team_id: "T", deleted: false, is_bot: false },
    });
    expect(shared.allowed).toBe(false);
    const pending = authorizeSlackDestination({
      approval: { installationId: "i", orgId: "o", channelId: "C", status: "active", sharingPolicyAcknowledged: true },
      expectedInstallationId: "i", expectedOrgId: "o", expectedTeamId: "T", expectedChannelId: "C", expectedPosterUserId: "U",
      channel: { id: "C", context_team_id: "T", pending_shared: ["T2"], is_channel: true, is_member: true },
      user: { id: "U", team_id: "T", deleted: false, is_bot: false },
    });
    expect(pending.allowed).toBe(false);
  });

  it("allows a broad-policy internal channel when Slack returns the exact channel without is_member", () => {
    const allowed = authorizeSlackDestination({
      approval: null,
      policyEnabled: true,
      expectedInstallationId: "i", expectedOrgId: "o", expectedTeamId: "T", expectedChannelId: "C", expectedPosterUserId: "U",
      channel: { id: "C", context_team_id: "T", shared_team_ids: ["T"], is_channel: true, is_member: false },
      user: { id: "U", team_id: "T", deleted: false, is_bot: false },
    });
    expect(allowed.allowed).toBe(true);
  });

  it("keeps shared, pending, DM, and cross-team channels denied in broad mode", () => {
    const base = { approval: null, policyEnabled: true, expectedInstallationId: "i", expectedOrgId: "o", expectedTeamId: "T", expectedChannelId: "C", expectedPosterUserId: "U", user: { id: "U", team_id: "T" } };
    for (const channel of [
      { id: "C", context_team_id: "T", shared_team_ids: ["T", "T2"], is_channel: true },
      { id: "C", context_team_id: "T", pending_shared: ["T2"], is_channel: true },
      { id: "C", context_team_id: "T", is_im: true },
      { id: "C", context_team_id: "T", is_channel: true, is_shared: true },
    ]) {
      expect(authorizeSlackDestination({ ...base, channel }).allowed).toBe(false);
    }
  });

  it("preserves Slack Retry-After metadata for transient authority failures", async () => {
    slack.channelInfo.mockRejectedValueOnce({ data: { retry_after: 600 } });
    slack.userInfo.mockResolvedValueOnce({ user: { id: "U" } });

    await expect(verifySlackDestination({
      token: "xoxb-test",
      approval: { installationId: "i", orgId: "o", channelId: "C", status: "active", sharingPolicyAcknowledged: true },
      installationId: "i",
      orgId: "o",
      teamId: "T",
      channelId: "C",
      posterUserId: "U",
    })).resolves.toEqual({ allowed: false, reason: "slack_authority_unavailable", retryAfterSeconds: 600 });
  });

  it("rejects unapproved destinations before making Slack authority calls", async () => {
    slack.channelInfo.mockClear();
    slack.userInfo.mockClear();
    await expect(verifySlackDestination({
      token: "xoxb-test",
      approval: null,
      installationId: "i",
      orgId: "o",
      teamId: "T",
      channelId: "C",
      posterUserId: "U",
    })).resolves.toEqual({ allowed: false, reason: "channel_not_approved" });
    expect(slack.channelInfo).not.toHaveBeenCalled();
    expect(slack.userInfo).not.toHaveBeenCalled();
  });

  it("turns permanent Slack channel errors into terminal denials", async () => {
    slack.channelInfo.mockRejectedValueOnce({ data: { error: "channel_not_found" } });
    slack.userInfo.mockResolvedValueOnce({ user: { id: "U" } });
    await expect(verifySlackDestination({
      token: "xoxb-test",
      approval: { installationId: "i", orgId: "o", channelId: "C", status: "active", sharingPolicyAcknowledged: true },
      installationId: "i",
      orgId: "o",
      teamId: "T",
      channelId: "C",
      posterUserId: "U",
    })).resolves.toEqual({ allowed: false, reason: "slack_channel_not_found" });
  });
});
