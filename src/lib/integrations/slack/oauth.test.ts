import { WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

import { buildSlackAuthUrl, exchangeSlackCode } from "./oauth";

const access = vi.fn();

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(function WebClient() {
    return {
    oauth: {
      v2: { access },
    },
    };
  }),
}));

describe("slack/oauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("buildSlackAuthUrl includes bot scopes, redirect URI, and state", () => {
    const url = buildSlackAuthUrl({
      clientId: "client-1",
      redirectUri: "https://app.example.com/api/oauth/slack/callback",
      signedState: "user-1.1760000000.hmac",
    });

    expect(url).toContain("client_id=client-1");
    expect(url).toContain("scope=chat%3Awrite%2Cim%3Awrite");
    expect(url).toContain("users%3Aread.email");
    expect(url).toContain("user_scope=");
    expect(url).toContain(
      "redirect_uri=https%3A%2F%2Fapp.example.com%2Fapi%2Foauth%2Fslack%2Fcallback",
    );
    expect(url).toContain("state=user-1.1760000000.hmac");
  });

  it("exchangeSlackCode maps a successful Slack OAuth response", async () => {
    access.mockResolvedValueOnce({
      ok: true,
      access_token: "xoxb-token",
      bot_user_id: "B123",
      app_id: "A123",
      team: { id: "T123", name: "Test Team" },
      scope: "chat:write,im:write",
      authed_user: {
        id: "U123",
        access_token: "xoxp-token",
        scope: "users:read",
      },
    });

    await expect(
      exchangeSlackCode({
        clientId: "client-1",
        clientSecret: "secret-1",
        code: "code-1",
        redirectUri: "https://app.example.com/api/oauth/slack/callback",
      }),
    ).resolves.toEqual({
      botToken: "xoxb-token",
      botUserId: "B123",
      appId: "A123",
      teamId: "T123",
      teamName: "Test Team",
      scopes: ["chat:write", "im:write"],
      userToken: "xoxp-token",
      userId: "U123",
      userScopes: ["users:read"],
    });
    expect(WebClient).toHaveBeenCalledWith();
    expect(access).toHaveBeenCalledWith({
      client_id: "client-1",
      client_secret: "secret-1",
      code: "code-1",
      redirect_uri: "https://app.example.com/api/oauth/slack/callback",
    });
  });

  it("exchangeSlackCode throws ProviderError when Slack rejects the code", async () => {
    access.mockResolvedValueOnce({ ok: false, error: "invalid_code" });

    await expect(
      exchangeSlackCode({
        clientId: "client-1",
        clientSecret: "secret-1",
        code: "bad-code",
        redirectUri: "https://app.example.com/api/oauth/slack/callback",
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("exchangeSlackCode handles responses without authed_user", async () => {
    access.mockResolvedValueOnce({
      ok: true,
      access_token: "xoxb-token",
      bot_user_id: "B123",
      app_id: "A123",
      team: { id: "T123" },
      scope: "chat:write",
    });

    const result = await exchangeSlackCode({
      clientId: "client-1",
      clientSecret: "secret-1",
      code: "code-1",
      redirectUri: "https://app.example.com/api/oauth/slack/callback",
    });

    expect(result.userToken).toBeNull();
    expect(result.userId).toBeNull();
    expect(result.userScopes).toEqual([]);
  });
});
