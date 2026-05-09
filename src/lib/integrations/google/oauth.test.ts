import { google } from "googleapis";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

import {
  buildGoogleAuthUrl,
  buildGoogleOauthClient,
  exchangeGoogleCode,
  GOOGLE_CALENDAR_SCOPES,
} from "./oauth";

const mocks = vi.hoisted(() => ({
  generateAuthUrl: vi.fn(),
  getToken: vi.fn(),
  setCredentials: vi.fn(),
  verifyIdToken: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(function OAuth2() {
        return mocks;
      }),
    },
  },
}));

describe("google/oauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateAuthUrl.mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth");
    mocks.getToken.mockResolvedValue({
      tokens: {
        access_token: "ya29-access",
        refresh_token: "refresh-token",
        expiry_date: Date.UTC(2026, 4, 9, 21, 0, 0),
        scope:
          "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email",
        id_token: "id-token",
      },
    });
    mocks.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: "user@example.com" }),
    });
  });

  it("GOOGLE_CALENDAR_SCOPES contains calendar events and userinfo email only", () => {
    expect(GOOGLE_CALENDAR_SCOPES).toEqual([
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
  });

  it("buildGoogleOauthClient creates a google OAuth2 client", () => {
    const client = buildGoogleOauthClient({
      clientId: "client-1",
      clientSecret: "secret-1",
      redirectUri: "https://app.example.com/api/oauth/google/callback",
    });

    expect(google.auth.OAuth2).toHaveBeenCalledWith(
      "client-1",
      "secret-1",
      "https://app.example.com/api/oauth/google/callback",
    );
    expect(client).toBe(mocks);
  });

  it("buildGoogleAuthUrl requests offline consent with the signed state", () => {
    const url = buildGoogleAuthUrl({
      client: mocks as never,
      signedState: "user-1.1760000000.hmac",
    });

    expect(url).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(mocks.generateAuthUrl).toHaveBeenCalledWith({
      access_type: "offline",
      prompt: "consent",
      scope: [...GOOGLE_CALENDAR_SCOPES],
      state: "user-1.1760000000.hmac",
      include_granted_scopes: true,
    });
  });

  it("exchangeGoogleCode maps a successful token response", async () => {
    await expect(
      exchangeGoogleCode({
        client: mocks as never,
        code: "code-1",
        clientId: "client-1",
      }),
    ).resolves.toEqual({
      accessToken: "ya29-access",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: "2026-05-09T21:00:00.000Z",
      scopes: [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
      email: "user@example.com",
    });
    expect(mocks.getToken).toHaveBeenCalledWith("code-1");
    expect(mocks.setCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: "ya29-access" }),
    );
    expect(mocks.verifyIdToken).toHaveBeenCalledWith({
      idToken: "id-token",
      audience: "client-1",
    });
  });

  it("exchangeGoogleCode throws ProviderError when getToken throws", async () => {
    mocks.getToken.mockRejectedValueOnce(new Error("invalid_grant"));

    await expect(
      exchangeGoogleCode({
        client: mocks as never,
        code: "bad-code",
        clientId: "client-1",
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("exchangeGoogleCode throws ProviderError when access_token is missing", async () => {
    mocks.getToken.mockResolvedValueOnce({ tokens: { refresh_token: "refresh" } });

    await expect(
      exchangeGoogleCode({
        client: mocks as never,
        code: "code-1",
        clientId: "client-1",
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("exchangeGoogleCode handles missing id_token gracefully", async () => {
    mocks.getToken.mockResolvedValueOnce({
      tokens: {
        access_token: "ya29-access",
        refresh_token: "refresh-token",
        expiry_date: Date.UTC(2026, 4, 9, 21, 0, 0),
      },
    });

    const result = await exchangeGoogleCode({
      client: mocks as never,
      code: "code-1",
      clientId: "client-1",
    });

    expect(result.email).toBeNull();
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it("exchangeGoogleCode handles verifyIdToken failures gracefully", async () => {
    mocks.verifyIdToken.mockRejectedValueOnce(new Error("bad id token"));

    const result = await exchangeGoogleCode({
      client: mocks as never,
      code: "code-1",
      clientId: "client-1",
    });

    expect(result.email).toBeNull();
  });

  it("exchangeGoogleCode handles missing refresh_token", async () => {
    mocks.getToken.mockResolvedValueOnce({
      tokens: {
        access_token: "ya29-access",
        expiry_date: Date.UTC(2026, 4, 9, 21, 0, 0),
      },
    });

    const result = await exchangeGoogleCode({
      client: mocks as never,
      code: "code-1",
      clientId: "client-1",
    });

    expect(result.refreshToken).toBeNull();
  });
});
