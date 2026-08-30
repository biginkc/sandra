import "server-only";

import { createHash, createHmac } from "node:crypto";

import { ConfigurationError, DatabaseError } from "@/lib/errors/classes";
import { createAdminClient } from "@/lib/supabase/admin";

import { EsignSecret } from "./secret";

export type DecryptedEsignCredentials = {
  apiKey: EsignSecret;
  clientId: string;
  providerAccountId: string;
  sendingEnabled: boolean;
  testMode: true;
  callbackSecretHash: string;
};

type EsignRpcClient = {
  rpc(
    fn: "upsert_org_esign_integration",
    args: {
      p_org_id: string;
      p_api_key: string;
      p_api_key_last_four: string;
      p_client_id: string;
      p_provider_account_id: string;
      p_callback_secret_hash: string;
      p_actor_id: string;
      p_key: string;
    },
  ): Promise<{ error: { message: string; code?: string } | null }>;
  rpc(
    fn: "get_org_esign_credentials",
    args: { p_org_id: string; p_key: string },
  ): Promise<{
    data: Array<{
      api_key: string;
      client_id: string;
      provider_account_id: string;
      sending_enabled: boolean;
      test_mode: boolean;
      callback_secret_hash: string;
    }> | null;
    error: { message: string; code?: string } | null;
  }>;
  rpc(
    fn: "delete_org_esign_integration",
    args: { p_org_id: string; p_actor_id: string },
  ): Promise<{ error: { message: string; code?: string } | null }>;
};

function adminRpc(): EsignRpcClient {
  return createAdminClient() as unknown as EsignRpcClient;
}

function encryptionKey(): string {
  const key = process.env.ESIGN_CREDENTIAL_ENCRYPTION_KEY;
  if (!key) {
    throw new ConfigurationError(
      "ESIGN_CREDENTIAL_ENCRYPTION_KEY is required.",
    );
  }
  return key;
}

function callbackDerivationKey(): string {
  const key = process.env.DROPBOX_SIGN_CALLBACK_SECRET_KEY;
  if (!key) {
    throw new ConfigurationError(
      "DROPBOX_SIGN_CALLBACK_SECRET_KEY is required.",
    );
  }
  return key;
}

export function configuredDropboxSignClientId(): string {
  const clientId = process.env.DROPBOX_SIGN_CLIENT_ID?.trim();
  if (!clientId) {
    throw new ConfigurationError("DROPBOX_SIGN_CLIENT_ID is required.");
  }
  return clientId;
}

export function configuredDropboxSignEmbeddedDomain(): string {
  const domain = process.env.DROPBOX_SIGN_EMBEDDED_DOMAIN?.trim();
  if (!domain) {
    throw new ConfigurationError("DROPBOX_SIGN_EMBEDDED_DOMAIN is required.");
  }
  return domain;
}

/**
 * Server-only deterministic path secret for Session 04's callback URL.
 * Only its SHA-256 digest is persisted. Never return this from an action.
 */
export function callbackPathSecretForOrg(orgId: string): EsignSecret {
  return new EsignSecret(
    createHmac("sha256", callbackDerivationKey())
      .update(`dropbox_sign:${orgId}`)
      .digest("base64url"),
  );
}

function callbackSecretHashForOrg(orgId: string): string {
  return createHash("sha256")
    .update(callbackPathSecretForOrg(orgId).reveal())
    .digest("hex");
}

export async function saveEsignCredentials(input: {
  orgId: string;
  actorId: string;
  apiKey: string;
  clientId: string;
  providerAccountId: string;
}): Promise<void> {
  const apiKey = input.apiKey.trim();
  const { error } = await adminRpc().rpc("upsert_org_esign_integration", {
    p_org_id: input.orgId,
    p_api_key: apiKey,
    p_api_key_last_four: apiKey.slice(-4),
    p_client_id: input.clientId,
    p_provider_account_id: input.providerAccountId,
    p_callback_secret_hash: callbackSecretHashForOrg(input.orgId),
    p_actor_id: input.actorId,
    p_key: encryptionKey(),
  });
  if (error) {
    throw new DatabaseError("Failed to save Dropbox Sign credentials.", {
      code: error.code,
    });
  }
}

export async function getEsignCredentials(
  orgId: string,
): Promise<DecryptedEsignCredentials | null> {
  const { data, error } = await adminRpc().rpc("get_org_esign_credentials", {
    p_org_id: orgId,
    p_key: encryptionKey(),
  });
  if (error) {
    throw new DatabaseError("Failed to load Dropbox Sign credentials.", {
      code: error.code,
    });
  }
  const row = data?.[0];
  if (!row) return null;
  if (!row.test_mode) {
    throw new ConfigurationError(
      "Dropbox Sign must remain in test mode for Sandra v1.",
    );
  }
  return {
    apiKey: new EsignSecret(row.api_key),
    clientId: row.client_id,
    providerAccountId: row.provider_account_id,
    sendingEnabled: row.sending_enabled,
    testMode: true,
    callbackSecretHash: row.callback_secret_hash,
  };
}

export async function deleteEsignCredentials(
  orgId: string,
  actorId: string,
): Promise<void> {
  const { error } = await adminRpc().rpc("delete_org_esign_integration", {
    p_org_id: orgId,
    p_actor_id: actorId,
  });
  if (error) {
    throw new DatabaseError(
      error.code === "23514"
        ? "Finish active eSign work before disconnecting Dropbox Sign."
        : "Failed to disconnect Dropbox Sign.",
      { code: error.code },
    );
  }
}
