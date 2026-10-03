import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import { exchangeSlackCode } from "@/lib/integrations/slack/oauth";
import { verifyOAuthState } from "@/lib/integrations/slack/state";
import { upsertOAuthToken } from "@/lib/integrations/tokens/store";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

vi.mock("@/lib/integrations/slack/oauth", () => ({
  exchangeSlackCode: vi.fn(),
}));

vi.mock("@/lib/integrations/slack/state", () => ({
  verifyOAuthState: vi.fn(),
}));

const slackInstallationMocks = vi.hoisted(() => ({
  consumeSlackOAuthNonce: vi.fn(),
  hashSlackOAuthNonce: vi.fn((value: string) => `hash:${value}`),
  upsertSlackAccountLink: vi.fn(),
  upsertSlackInstallation: vi.fn(),
  upsertSlackInstallationAndAccountLink: vi.fn(),
}));

vi.mock("@/lib/integrations/slack/installation", () => slackInstallationMocks);

vi.mock("@/lib/integrations/tokens/store", () => ({
  upsertOAuthToken: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

const createClientMock = vi.mocked(createClient);
const exchangeSlackCodeMock = vi.mocked(exchangeSlackCode);
const verifyOAuthStateMock = vi.mocked(verifyOAuthState);
const upsertOAuthTokenMock = vi.mocked(upsertOAuthToken);
const reportErrorMock = vi.mocked(reportError);

function mockUser(user: { id: string } | null) {
  createClientMock.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user },
      }),
    },
  } as never);
}

function request(search: string) {
  return new Request(`https://app.example.com/api/oauth/slack/callback${search}`);
}

describe("oauth/slack/callback route", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("OAUTH_STATE_SIGNING_SECRET", "state-secret");
    vi.stubEnv("SLACK_CLIENT_ID", "client-1");
    vi.stubEnv("SLACK_CLIENT_SECRET", "secret-1");
    vi.stubEnv("APP_URL", "https://app.example.com");
    mockUser({ id: "user-1" });
    verifyOAuthStateMock.mockReturnValue(true);
    exchangeSlackCodeMock.mockResolvedValue({
      botToken: "xoxb-token",
      botUserId: "B123",
      appId: "A123",
      teamId: "T123",
      teamName: "Test Team",
      scopes: ["chat:write"],
      userToken: null,
      userId: "U123",
      userScopes: [],
    });
    upsertOAuthTokenMock.mockResolvedValue(undefined);
    slackInstallationMocks.consumeSlackOAuthNonce.mockResolvedValue(true);
    slackInstallationMocks.upsertSlackInstallation.mockResolvedValue({ installationId: "I123", installationVersion: 1 });
    slackInstallationMocks.upsertSlackAccountLink.mockResolvedValue("L123");
    slackInstallationMocks.upsertSlackInstallationAndAccountLink.mockResolvedValue({ installationId: "I123", installationVersion: 1, accountLinkId: "L123" });
  });

  it("redirects to /login when not authenticated", async () => {
    mockUser(null);

    const response = await GET(request("?code=code-1&state=state-1"));

    expect(response.headers.get("location")).toBe("https://app.example.com/login");
    expect(exchangeSlackCodeMock).not.toHaveBeenCalled();
  });

  it("redirects to state error when state is missing", async () => {
    const response = await GET(request("?code=code-1"));

    expect(response.headers.get("location")).toBe(
      "https://app.example.com/settings/integrations?error=state",
    );
    expect(verifyOAuthStateMock).not.toHaveBeenCalled();
  });

  it("redirects to state error when verifyOAuthState rejects tampered state", async () => {
    verifyOAuthStateMock.mockReturnValueOnce(false);

    const response = await GET(request("?code=code-1&state=tampered"));

    expect(response.headers.get("location")).toBe(
      "https://app.example.com/settings/integrations?error=state",
    );
    expect(exchangeSlackCodeMock).not.toHaveBeenCalled();
  });

  it("upserts only the bot token when userToken is absent", async () => {
    const response = await GET(request("?code=code-1&state=state-1"));

    expect(response.headers.get("location")).toBe(
      "https://app.example.com/settings/integrations?connected=slack",
    );
    expect(exchangeSlackCodeMock).toHaveBeenCalledWith({
      clientId: "client-1",
      clientSecret: "secret-1",
      code: "code-1",
      redirectUri: "https://app.example.com/api/oauth/slack/callback",
    });
    expect(upsertOAuthTokenMock).toHaveBeenCalledTimes(1);
    expect(upsertOAuthTokenMock).toHaveBeenCalledWith({
      userId: "user-1",
      provider: "slack",
      tokenType: "bot",
      accessToken: "xoxb-token",
      refreshToken: null,
      accessTokenExpiresAt: null,
      scopes: ["chat:write"],
      externalAccountId: "U123",
    });
  });

  it("upserts bot and user tokens when userToken is present", async () => {
    exchangeSlackCodeMock.mockResolvedValueOnce({
      botToken: "xoxb-token",
      botUserId: "B123",
      appId: "A123",
      teamId: "T123",
      teamName: "Test Team",
      scopes: ["chat:write"],
      userToken: "xoxp-token",
      userId: "U123",
      userScopes: ["users:read"],
    });

    const response = await GET(request("?code=code-1&state=state-1"));

    expect(response.headers.get("location")).toBe(
      "https://app.example.com/settings/integrations?connected=slack",
    );
    expect(upsertOAuthTokenMock).toHaveBeenCalledTimes(2);
    expect(upsertOAuthTokenMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ tokenType: "bot", accessToken: "xoxb-token" }),
    );
    expect(upsertOAuthTokenMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tokenType: "user", accessToken: "xoxp-token" }),
    );
  });

  it("redirects to callback error when Slack exchange fails", async () => {
    const error = new ProviderError("oauth.v2.access failed: invalid_code", "slack");
    exchangeSlackCodeMock.mockRejectedValueOnce(error);

    const response = await GET(request("?code=bad-code&state=state-1"));

    expect(response.headers.get("location")).toBe(
      "https://app.example.com/settings/integrations?error=callback",
    );
    expect(reportErrorMock).toHaveBeenCalledWith(error, {
      tags: { surface: "oauth_slack_callback" },
    });
  });

  it("requires a live nonce and current org membership for preview OAuth state", async () => {
    const claims = { userId: "user-1", orgId: "org-1", nonce: "nonce-1", purpose: "slack_installation", issuedAt: 1760000000 };
    const state = `v2.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    const membershipBuilder = { select: vi.fn(), eq: vi.fn() };
    membershipBuilder.select.mockReturnValue(membershipBuilder);
    let eqCalls = 0;
    membershipBuilder.eq.mockImplementation(() => {
      eqCalls += 1;
      return eqCalls === 2 ? Promise.resolve({ data: [{ org_id: "org-2", user_id: "user-1" }], error: null }) : membershipBuilder;
    });
    createClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) }, from: vi.fn(() => membershipBuilder) } as never);

    const response = await GET(request(`?code=code-1&state=${encodeURIComponent(state)}`));
    expect(response.headers.get("location")).toBe("https://app.example.com/settings/integrations?error=state");
    expect(exchangeSlackCodeMock).not.toHaveBeenCalled();

    eqCalls = 0;
    membershipBuilder.eq.mockImplementation(() => {
      eqCalls += 1;
      return eqCalls === 2 ? Promise.resolve({ data: [{ org_id: "org-1", user_id: "user-1" }], error: null }) : membershipBuilder;
    });
    slackInstallationMocks.consumeSlackOAuthNonce.mockResolvedValueOnce(false);
    const replay = await GET(request(`?code=code-1&state=${encodeURIComponent(state)}`));
    expect(replay.headers.get("location")).toBe("https://app.example.com/settings/integrations?error=state");
    expect(exchangeSlackCodeMock).not.toHaveBeenCalled();
  });

  it("refuses preview authority when Slack omits returned installation identity", async () => {
    const claims = { userId: "user-1", orgId: "org-1", nonce: "nonce-1", purpose: "slack_installation", issuedAt: 1760000000 };
    const state = `v2.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    const membershipBuilder = { select: vi.fn(), eq: vi.fn() };
    membershipBuilder.select.mockReturnValue(membershipBuilder);
    let eqCalls = 0;
    membershipBuilder.eq.mockImplementation(() => {
      eqCalls += 1;
      return eqCalls === 2 ? Promise.resolve({ data: [{ org_id: "org-1", user_id: "user-1" }], error: null }) : membershipBuilder;
    });
    createClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) }, from: vi.fn(() => membershipBuilder) } as never);
    exchangeSlackCodeMock.mockResolvedValueOnce({ botToken: "xoxb-token", botUserId: "", appId: "A123", teamId: "T123", teamName: "Test Team", scopes: [], userToken: null, userId: "U123", userScopes: [] });
    const response = await GET(request(`?code=code-1&state=${encodeURIComponent(state)}`));
    expect(response.headers.get("location")).toBe("https://app.example.com/settings/integrations?error=callback");
    expect(slackInstallationMocks.upsertSlackInstallation).not.toHaveBeenCalled();
  });

  it("persists preview installation and account binding in one RPC after membership recheck", async () => {
    const claims = { userId: "user-1", orgId: "org-1", nonce: "nonce-1", purpose: "slack_installation", issuedAt: 1760000000 };
    const state = `v2.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    const membershipBuilder = { select: vi.fn(), eq: vi.fn() };
    membershipBuilder.select.mockReturnValue(membershipBuilder);
    let eqCalls = 0;
    membershipBuilder.eq.mockImplementation(() => {
      eqCalls += 1;
      return eqCalls === 2 ? Promise.resolve({ data: [{ org_id: "org-1", user_id: "user-1" }], error: null }) : membershipBuilder;
    });
    createClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) }, from: vi.fn(() => membershipBuilder) } as never);

    const response = await GET(request(`?code=code-1&state=${encodeURIComponent(state)}`));
    expect(response.headers.get("location")).toBe("https://app.example.com/settings/integrations?connected=slack");
    expect(slackInstallationMocks.upsertSlackInstallationAndAccountLink).toHaveBeenCalledWith({
      orgId: "org-1", teamId: "T123", appId: "A123", teamName: "Test Team", botUserId: "B123", botToken: "xoxb-token", scopes: ["chat:write"], installedBy: "user-1", slackUserId: "U123",
    });
    expect(slackInstallationMocks.upsertSlackInstallation).not.toHaveBeenCalled();
    expect(slackInstallationMocks.upsertSlackAccountLink).not.toHaveBeenCalled();
  });
});
