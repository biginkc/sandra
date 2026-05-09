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
});
