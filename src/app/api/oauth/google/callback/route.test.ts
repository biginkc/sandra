import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import {
  buildGoogleOauthClient,
  exchangeGoogleCode,
} from "@/lib/integrations/google/oauth";
import { verifyOAuthState } from "@/lib/integrations/slack/state";
import { upsertOAuthToken } from "@/lib/integrations/tokens/store";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

vi.mock("@/lib/integrations/google/oauth", () => ({
  buildGoogleOauthClient: vi.fn(),
  exchangeGoogleCode: vi.fn(),
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
const buildGoogleOauthClientMock = vi.mocked(buildGoogleOauthClient);
const exchangeGoogleCodeMock = vi.mocked(exchangeGoogleCode);
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
  return new Request(
    `https://app.example.com/api/oauth/google/callback${search}`,
  );
}

describe("oauth/google/callback route", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("OAUTH_STATE_SIGNING_SECRET", "state-secret");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-1");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "secret-1");
    vi.stubEnv("APP_URL", "https://app.example.com");
    mockUser({ id: "user-1" });
    buildGoogleOauthClientMock.mockReturnValue({} as never);
    verifyOAuthStateMock.mockReturnValue(true);
    exchangeGoogleCodeMock.mockResolvedValue({
      accessToken: "ya29-access",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: "2026-05-09T21:00:00.000Z",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      email: "user@example.com",
    });
    upsertOAuthTokenMock.mockResolvedValue(undefined);
  });

  it("redirects to /login when not authenticated", async () => {
    mockUser(null);

    const response = await GET(request("?code=code-1&state=state-1"));

    expect(response.headers.get("location")).toBe("https://app.example.com/login");
    expect(exchangeGoogleCodeMock).not.toHaveBeenCalled();
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
    expect(exchangeGoogleCodeMock).not.toHaveBeenCalled();
  });

  it("upserts a Google user token on success", async () => {
    const response = await GET(request("?code=code-1&state=state-1"));

    expect(response.headers.get("location")).toBe(
      "https://app.example.com/settings/integrations?connected=google",
    );
    expect(buildGoogleOauthClientMock).toHaveBeenCalledWith({
      clientId: "client-1",
      clientSecret: "secret-1",
      redirectUri: "https://app.example.com/api/oauth/google/callback",
    });
    expect(exchangeGoogleCodeMock).toHaveBeenCalledWith({
      client: {},
      code: "code-1",
      clientId: "client-1",
    });
    expect(upsertOAuthTokenMock).toHaveBeenCalledWith({
      userId: "user-1",
      provider: "google",
      tokenType: "user",
      accessToken: "ya29-access",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: "2026-05-09T21:00:00.000Z",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      externalAccountId: "user@example.com",
    });
  });

  it("passes null refreshToken through when Google omits it", async () => {
    exchangeGoogleCodeMock.mockResolvedValueOnce({
      accessToken: "ya29-access",
      refreshToken: null,
      accessTokenExpiresAt: "2026-05-09T21:00:00.000Z",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      email: "user@example.com",
    });

    await GET(request("?code=code-1&state=state-1"));

    expect(upsertOAuthTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: null }),
    );
  });

  it("redirects to callback error when Google exchange fails", async () => {
    const error = new ProviderError("google getToken failed: invalid_grant", "google");
    exchangeGoogleCodeMock.mockRejectedValueOnce(error);

    const response = await GET(request("?code=bad-code&state=state-1"));

    expect(response.headers.get("location")).toBe(
      "https://app.example.com/settings/integrations?error=callback",
    );
    expect(reportErrorMock).toHaveBeenCalledWith(error, {
      tags: { surface: "oauth_google_callback" },
    });
  });
});
