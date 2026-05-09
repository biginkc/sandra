import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigurationError, DatabaseError } from "@/lib/errors/classes";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  deleteOAuthTokens,
  getDecryptedToken,
  OAuthSecret,
  upsertOAuthToken,
} from "./store";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

const rpc = vi.fn();
const createAdminClientMock = vi.mocked(createAdminClient);

describe("tokens/store", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "test-key");
    createAdminClientMock.mockReturnValue({ rpc } as never);
    rpc.mockResolvedValue({ data: null, error: null });
  });

  it("getDecryptedToken returns null when no row exists", async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });

    await expect(
      getDecryptedToken({
        userId: "user-1",
        provider: "slack",
        tokenType: "bot",
      }),
    ).resolves.toBeNull();
  });

  it("getDecryptedToken throws ConfigurationError when OAUTH_TOKEN_ENCRYPTION_KEY is unset", async () => {
    vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "");

    await expect(
      getDecryptedToken({
        userId: "user-1",
        provider: "slack",
        tokenType: "bot",
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("getDecryptedToken wraps access_token and refresh_token as OAuthSecret", async () => {
    rpc.mockResolvedValueOnce({
      data: [
        {
          access_token: "xoxb-access",
          refresh_token: "xoxr-refresh",
          access_token_expires_at: "2026-05-09T20:00:00.000Z",
          scopes: ["chat:write"],
          external_account_id: "U123",
        },
      ],
      error: null,
    });

    const token = await getDecryptedToken({
      userId: "user-1",
      provider: "slack",
      tokenType: "bot",
    });

    expect(token?.accessToken).toBeInstanceOf(OAuthSecret);
    expect(token?.refreshToken).toBeInstanceOf(OAuthSecret);
    expect(token?.accessToken.reveal()).toBe("xoxb-access");
    expect(token?.refreshToken?.reveal()).toBe("xoxr-refresh");
    expect(token?.scopes).toEqual(["chat:write"]);
    expect(token?.externalAccountId).toBe("U123");
  });

  it("upsertOAuthToken passes plaintext to RPC; never logs it", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await upsertOAuthToken({
      userId: "user-1",
      provider: "google",
      tokenType: "user",
      accessToken: "ya29-access",
      refreshToken: "refresh-secret",
      accessTokenExpiresAt: null,
      scopes: ["calendar.events"],
      externalAccountId: "google-user",
    });

    expect(rpc).toHaveBeenCalledWith("upsert_oauth_token", {
      p_user_id: "user-1",
      p_provider: "google",
      p_token_type: "user",
      p_access: "ya29-access",
      p_refresh: "refresh-secret",
      p_expires_at: null,
      p_scopes: ["calendar.events"],
      p_account: "google-user",
      p_key: "test-key",
    });
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("upsertOAuthToken throws DatabaseError on RPC error", async () => {
    rpc.mockResolvedValueOnce({
      error: { code: "XX000", message: "encrypt failed" },
    });

    await expect(
      upsertOAuthToken({
        userId: "user-1",
        provider: "slack",
        tokenType: "bot",
        accessToken: "xoxb-access",
        refreshToken: null,
        accessTokenExpiresAt: null,
        scopes: [],
        externalAccountId: null,
      }),
    ).rejects.toBeInstanceOf(DatabaseError);
  });

  it("deleteOAuthTokens calls the service-role RPC", async () => {
    await deleteOAuthTokens({ userId: "user-1", provider: "slack" });

    expect(rpc).toHaveBeenCalledWith("delete_oauth_tokens", {
      p_user_id: "user-1",
      p_provider: "slack",
    });
  });

  it("deleteOAuthTokens throws DatabaseError on RPC error", async () => {
    rpc.mockResolvedValueOnce({
      error: { code: "XX000", message: "delete failed" },
    });

    await expect(
      deleteOAuthTokens({ userId: "user-1", provider: "slack" }),
    ).rejects.toBeInstanceOf(DatabaseError);
  });
});
