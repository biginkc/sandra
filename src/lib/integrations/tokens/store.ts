import { ConfigurationError, DatabaseError } from "@/lib/errors/classes";
import { createAdminClient } from "@/lib/supabase/admin";

import { OAuthSecret } from "./oauth-secret";

export { OAuthSecret };

export type OauthProvider = "slack" | "google";
export type OauthTokenType = "user" | "bot";

export interface DecryptedOAuthToken {
  accessToken: OAuthSecret;
  refreshToken: OAuthSecret | null;
  expiresAt: string | null;
  scopes: string[];
  externalAccountId: string | null;
}

export interface UpsertOAuthTokenInput {
  userId: string;
  provider: OauthProvider;
  tokenType: OauthTokenType;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
  scopes: string[];
  externalAccountId: string | null;
}

type RpcClient = {
  rpc(
    fn: "get_oauth_token",
    args: {
      p_user_id: string;
      p_provider: OauthProvider;
      p_token_type: OauthTokenType;
      p_key: string;
    },
  ): Promise<{
    data: Array<{
      access_token: string;
      refresh_token: string | null;
      access_token_expires_at: string | null;
      scopes: string[] | null;
      external_account_id: string | null;
    }> | null;
    error: { message: string; code?: string } | null;
  }>;
  rpc(
    fn: "upsert_oauth_token",
    args: {
      p_user_id: string;
      p_provider: OauthProvider;
      p_token_type: OauthTokenType;
      p_access: string;
      p_refresh: string | null;
      p_expires_at: string | null;
      p_scopes: string[];
      p_account: string | null;
      p_key: string;
    },
  ): Promise<{ error: { message: string; code?: string } | null }>;
  rpc(
    fn: "delete_oauth_tokens",
    args: {
      p_user_id: string;
      p_provider: OauthProvider;
    },
  ): Promise<{ error: { message: string; code?: string } | null }>;
};

function encryptionKey(): string {
  const key = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) {
    throw new ConfigurationError("OAUTH_TOKEN_ENCRYPTION_KEY is required");
  }
  return key;
}

function oauthRpcClient(): RpcClient {
  return createAdminClient() as unknown as RpcClient;
}

export async function getDecryptedToken(params: {
  userId: string;
  provider: OauthProvider;
  tokenType: OauthTokenType;
}): Promise<DecryptedOAuthToken | null> {
  const { data, error } = await oauthRpcClient().rpc("get_oauth_token", {
    p_user_id: params.userId,
    p_provider: params.provider,
    p_token_type: params.tokenType,
    p_key: encryptionKey(),
  });

  if (error) {
    throw new DatabaseError("Failed to decrypt OAuth token", {
      userId: params.userId,
      provider: params.provider,
      tokenType: params.tokenType,
      code: error.code,
      message: error.message,
    });
  }

  const row = data?.[0];
  if (!row) return null;

  return {
    accessToken: new OAuthSecret(row.access_token),
    refreshToken: row.refresh_token ? new OAuthSecret(row.refresh_token) : null,
    expiresAt: row.access_token_expires_at,
    scopes: row.scopes ?? [],
    externalAccountId: row.external_account_id,
  };
}

export async function upsertOAuthToken(
  input: UpsertOAuthTokenInput,
): Promise<void> {
  const { error } = await oauthRpcClient().rpc("upsert_oauth_token", {
    p_user_id: input.userId,
    p_provider: input.provider,
    p_token_type: input.tokenType,
    p_access: input.accessToken,
    p_refresh: input.refreshToken,
    p_expires_at: input.accessTokenExpiresAt,
    p_scopes: input.scopes,
    p_account: input.externalAccountId,
    p_key: encryptionKey(),
  });

  if (error) {
    throw new DatabaseError("Failed to upsert OAuth token", {
      userId: input.userId,
      provider: input.provider,
      tokenType: input.tokenType,
      code: error.code,
      message: error.message,
    });
  }
}

export async function deleteOAuthTokens(params: {
  userId: string;
  provider: OauthProvider;
}): Promise<void> {
  const { error } = await oauthRpcClient().rpc("delete_oauth_tokens", {
    p_user_id: params.userId,
    p_provider: params.provider,
  });

  if (error) {
    throw new DatabaseError("Failed to delete OAuth tokens", {
      userId: params.userId,
      provider: params.provider,
      code: error.code,
      message: error.message,
    });
  }
}
