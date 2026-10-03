import { createHash, randomBytes } from "node:crypto";

import { DatabaseError } from "@/lib/errors/classes";
import { createAdminClient } from "@/lib/supabase/admin";

import { OAuthSecret } from "../tokens/store";

const NONCE_TTL_SECONDS = 10 * 60;

export const SLACK_PREVIEW_REQUIRED_SCOPES = [
  "links:read",
  "links:write",
  "channels:read",
  "groups:read",
  "users:read",
] as const;

type InstallationRpcClient = {
  rpc(
    fn:
      | "create_slack_oauth_nonce"
      | "consume_slack_oauth_nonce"
      | "upsert_slack_installation"
      | "upsert_slack_installation_and_account_link"
      | "get_slack_installation"
      | "upsert_slack_account_link",
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};

function client(): InstallationRpcClient {
  return createAdminClient() as unknown as InstallationRpcClient;
}

function encryptionKey(): string {
  const key = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY is required");
  return key;
}

function throwRpc(error: { message: string; code?: string } | null, operation: string): void {
  if (!error) return;
  throw new DatabaseError(`Slack ${operation} failed`, {
    code: error.code,
    message: error.message,
  });
}

export function createSlackOAuthNonce(): { nonce: string; nonceHash: string; expiresAt: string } {
  const nonce = randomBytes(32).toString("base64url");
  const nonceHash = createHash("sha256").update(nonce).digest("hex");
  const expiresAt = new Date(Date.now() + NONCE_TTL_SECONDS * 1000).toISOString();
  return { nonce, nonceHash, expiresAt };
}

export async function persistSlackOAuthNonce(input: {
  nonceHash: string;
  userId: string;
  orgId: string;
  returnPath?: string | null;
  expiresAt: string;
}): Promise<void> {
  const { error } = await client().rpc("create_slack_oauth_nonce", {
    p_nonce_hash: input.nonceHash,
    p_user_id: input.userId,
    p_org_id: input.orgId,
    p_return_path: input.returnPath ?? null,
    p_expires_at: input.expiresAt,
  });
  throwRpc(error, "OAuth nonce insert");
}

export async function consumeSlackOAuthNonce(input: {
  nonceHash: string;
  userId: string;
  orgId: string;
}): Promise<boolean> {
  const { data, error } = await client().rpc("consume_slack_oauth_nonce", {
    p_nonce_hash: input.nonceHash,
    p_user_id: input.userId,
    p_org_id: input.orgId,
  });
  throwRpc(error, "OAuth nonce consume");
  return data === true;
}

export type SlackInstallation = {
  installationId: string;
  orgId: string;
  teamId: string;
  appId: string;
  teamName: string | null;
  botUserId: string;
  botToken: OAuthSecret;
  scopes: string[];
  installationVersion: number;
  status: "active" | "revoked";
};

export async function upsertSlackInstallation(input: {
  orgId: string;
  teamId: string;
  appId: string;
  teamName?: string | null;
  botUserId: string;
  botToken: string;
  scopes: string[];
  installedBy: string;
}): Promise<{ installationId: string; installationVersion: number }> {
  const { data, error } = await client().rpc("upsert_slack_installation", {
    p_org_id: input.orgId,
    p_team_id: input.teamId,
    p_app_id: input.appId,
    p_team_name: input.teamName ?? null,
    p_bot_user_id: input.botUserId,
    p_bot_token: input.botToken,
    p_scopes: input.scopes,
    p_installed_by: input.installedBy,
    p_key: encryptionKey(),
  });
  throwRpc(error, "installation upsert");
  const row = Array.isArray(data) ? (data[0] as { installation_id?: string; installation_version?: number } | undefined) : undefined;
  if (!row?.installation_id || typeof row.installation_version !== "number") {
    throw new DatabaseError("Slack installation upsert returned no installation", {});
  }
  return { installationId: row.installation_id, installationVersion: row.installation_version };
}

export async function getSlackInstallation(input: {
  orgId: string;
  teamId: string;
  appId: string;
}): Promise<SlackInstallation | null> {
  const { data, error } = await client().rpc("get_slack_installation", {
    p_org_id: input.orgId,
    p_team_id: input.teamId,
    p_app_id: input.appId,
    p_key: encryptionKey(),
  });
  throwRpc(error, "installation lookup");
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row) return null;
  if (typeof row.installation_id !== "string" || typeof row.org_id !== "string" || typeof row.team_id !== "string" || typeof row.app_id !== "string" || typeof row.bot_user_id !== "string" || typeof row.bot_token !== "string") {
    throw new DatabaseError("Slack installation lookup returned invalid identity", {});
  }
  const status = row.status === "revoked" ? "revoked" : row.status === "active" ? "active" : null;
  if (!status || typeof row.installation_version !== "number") {
    throw new DatabaseError("Slack installation lookup returned invalid status", {});
  }
  return {
    installationId: row.installation_id,
    orgId: row.org_id,
    teamId: row.team_id,
    appId: row.app_id,
    teamName: typeof row.team_name === "string" ? row.team_name : null,
    botUserId: row.bot_user_id,
    botToken: new OAuthSecret(row.bot_token),
    scopes: Array.isArray(row.scopes) ? row.scopes.filter((scope): scope is string => typeof scope === "string") : [],
    installationVersion: row.installation_version,
    status,
  };
}

export async function upsertSlackAccountLink(input: {
  installationId: string;
  orgId: string;
  userId: string;
  slackUserId: string;
}): Promise<string> {
  const { data, error } = await client().rpc("upsert_slack_account_link", {
    p_installation_id: input.installationId,
    p_org_id: input.orgId,
    p_user_id: input.userId,
    p_slack_user_id: input.slackUserId,
  });
  throwRpc(error, "account link upsert");
  if (typeof data !== "string") throw new DatabaseError("Slack account link upsert returned no link", {});
  return data;
}

export async function upsertSlackInstallationAndAccountLink(input: {
  orgId: string;
  teamId: string;
  appId: string;
  teamName?: string | null;
  botUserId: string;
  botToken: string;
  scopes: string[];
  installedBy: string;
  slackUserId: string;
}): Promise<{ installationId: string; installationVersion: number; accountLinkId: string }> {
  const { data, error } = await client().rpc("upsert_slack_installation_and_account_link", {
    p_org_id: input.orgId,
    p_team_id: input.teamId,
    p_app_id: input.appId,
    p_team_name: input.teamName ?? null,
    p_bot_user_id: input.botUserId,
    p_bot_token: input.botToken,
    p_scopes: input.scopes,
    p_installed_by: input.installedBy,
    p_user_id: input.installedBy,
    p_slack_user_id: input.slackUserId,
    p_key: encryptionKey(),
  });
  throwRpc(error, "installation and account-link upsert");
  const row = Array.isArray(data) ? (data[0] as { installation_id?: string; installation_version?: number; account_link_id?: string } | undefined) : undefined;
  if (!row?.installation_id || typeof row.installation_version !== "number" || !row.account_link_id) {
    throw new DatabaseError("Slack installation and account link upsert returned incomplete identity", {});
  }
  return { installationId: row.installation_id, installationVersion: row.installation_version, accountLinkId: row.account_link_id };
}

export function hasSlackPreviewScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return SLACK_PREVIEW_REQUIRED_SCOPES.every((scope) => granted.has(scope));
}

export function hashSlackOAuthNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}
