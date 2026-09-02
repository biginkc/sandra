"use server";

import { revalidatePath } from "next/cache";

import {
  getSingleActiveMembership,
  type Membership,
  type SingleActiveMembershipResolution,
} from "@/lib/auth/memberships";
import {
  AuthorizationError,
  DatabaseError,
  ProviderError,
  ValidationError,
} from "@/lib/errors/classes";
import { err, ok, type AppErrorShape, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import type { EsignConnectionStatus } from "./contracts";
import {
  configuredDropboxSignClientId,
  configuredDropboxSignEmbeddedDomain,
  saveEsignCredentials,
} from "./credentials";
import { createDropboxSignProvider } from "./dropbox-sign";
import { EsignSecret } from "./secret";

type StatusClient = {
  from(table: "org_esign_integrations"): {
    select(columns: string): {
      eq(
        column: "org_id",
        value: string,
      ): {
        maybeSingle(): Promise<{
          data: {
            api_key_last_four: string | null;
            sending_enabled: boolean;
            test_mode: boolean;
          } | null;
          error: { message: string; code?: string } | null;
        }>;
      };
    };
  };
};

type AdminIntegrationClient = {
  rpc(
    fn: "set_org_esign_sending_enabled",
    args: { p_org_id: string; p_actor_id: string; p_enabled: boolean },
  ): Promise<{ error: { message: string; code?: string } | null }>;
  rpc(
    fn: "disconnect_org_esign_integration",
    args: { p_org_id: string; p_actor_id: string },
  ): Promise<{
    data:
      | Array<{
          disconnected: boolean;
          sending_enabled: boolean;
          credentials_present: boolean;
          message: string;
        }>
      | null;
    error: { message: string; code?: string } | null;
  }>;
};

export type EsignDisconnectResult = {
  disconnected: boolean;
  sendingEnabled: boolean;
  credentialsPresent: boolean;
  message: string;
};

async function currentMembership(): Promise<Membership> {
  const resolution = await getSingleActiveMembership();
  if (!resolution.ok) {
    throw authorizationErrorForMembershipResolution(resolution);
  }
  return resolution.membership;
}

function authorizationErrorForMembershipResolution(
  resolution: Extract<SingleActiveMembershipResolution, { ok: false }>,
): AuthorizationError {
  if (resolution.reason === "missing") {
    return new AuthorizationError("Sign in with active organization access.");
  }
  return new AuthorizationError(
    "Choose a single active organization before managing Dropbox Sign.",
  );
}

function safeEsignError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): { ok: false; error: AppErrorShape } {
  if (error instanceof AuthorizationError) {
    return err({ code: "AUTHORIZATION", message: error.message });
  }
  if (error instanceof ValidationError) {
    return err({ code: "VALIDATION", message: error.message });
  }
  if (error instanceof DatabaseError) {
    return err({ code: "DATABASE", message: error.message });
  }
  if (error instanceof ProviderError) {
    return err({
      code: "PROVIDER",
      message:
        "Dropbox Sign could not validate the connection. Check the Primary API key and API app settings.",
    });
  }
  return err({ code: fallbackCode, message: fallbackMessage });
}

function requireOwner(membership: Membership): void {
  if (membership.role !== "owner") {
    throw new AuthorizationError(
      "Only organization owners can manage Dropbox Sign.",
    );
  }
}

export async function getEsignConnectionStatus(): Promise<
  Result<EsignConnectionStatus>
> {
  try {
    const membership = await currentMembership();
    const supabase = (await createClient()) as unknown as StatusClient;
    const { data, error } = await supabase
      .from("org_esign_integrations")
      .select("api_key_last_four, sending_enabled, test_mode")
      .eq("org_id", membership.org_id)
      .maybeSingle();
    if (error) {
      throw new DatabaseError("Failed to load Dropbox Sign status.", {
        code: error.code,
      });
    }
    if (data && !data.test_mode) {
      throw new DatabaseError("Dropbox Sign is not safely configured for v1.");
    }
    const credentialsPresent = Boolean(data?.api_key_last_four);
    return ok({
      connected: credentialsPresent,
      canManage: membership.role === "owner",
      sendingEnabled: credentialsPresent && (data?.sending_enabled ?? false),
      testMode: true,
      apiKeyLastFour: data?.api_key_last_four ?? null,
    });
  } catch (error) {
    reportError(error, { tags: { surface: "esign_connection_status" } });
    return safeEsignError(
      error,
      "ESIGN_STATUS_FAILED",
      "Dropbox Sign status is temporarily unavailable.",
    );
  }
}

export async function connectDropboxSignAction(
  apiKeyInput: string,
): Promise<Result<EsignConnectionStatus>> {
  try {
    const membership = await currentMembership();
    requireOwner(membership);
    const apiKey = apiKeyInput.trim();
    if (apiKey.length < 8) {
      throw new ValidationError("Enter a valid Dropbox Sign API key.");
    }
    const clientId = configuredDropboxSignClientId();
    const provider = createDropboxSignProvider({
      apiKey: new EsignSecret(apiKey),
      clientId,
      expectedDomain: configuredDropboxSignEmbeddedDomain(),
    });
    const validation = await provider.validateCredentials();
    const providerAccountId = validation.accountId?.trim();
    if (!providerAccountId) {
      throw new ValidationError(
        "Dropbox Sign did not return a valid provider account.",
      );
    }
    await saveEsignCredentials({
      orgId: membership.org_id,
      actorId: membership.user_id,
      apiKey,
      clientId,
      providerAccountId,
    });
    revalidatePath("/settings/integrations");
    return ok({
      connected: true,
      canManage: true,
      sendingEnabled: false,
      testMode: true,
      apiKeyLastFour: apiKey.slice(-4),
    });
  } catch (error) {
    reportError(error, { tags: { surface: "esign_connect" } });
    return safeEsignError(
      error,
      "ESIGN_CONNECT_FAILED",
      "Dropbox Sign could not be connected.",
    );
  }
}

export async function setEsignSendingEnabledAction(
  enabled: boolean,
  operatorConfirmed: boolean,
): Promise<Result<null>> {
  try {
    const membership = await currentMembership();
    requireOwner(membership);
    if (operatorConfirmed !== true) {
      throw new ValidationError(
        "Confirm the contract sending change before it is applied.",
      );
    }
    const { error } = await (
      createAdminClient() as unknown as AdminIntegrationClient
    ).rpc("set_org_esign_sending_enabled", {
      p_org_id: membership.org_id,
      p_actor_id: membership.user_id,
      p_enabled: enabled,
    });
    if (error) {
      throw new DatabaseError(
        enabled && error.code === "23514"
          ? "Verify the Dropbox Sign callback before enabling sending."
          : error.code === "P0002"
            ? "Connect Dropbox Sign before enabling sending."
            : "Dropbox Sign sending could not be updated.",
        { code: error.code },
      );
    }
    revalidatePath("/settings/integrations");
    return ok(null);
  } catch (error) {
    reportError(error, { tags: { surface: "esign_sending_toggle" } });
    return safeEsignError(
      error,
      "ESIGN_UPDATE_FAILED",
      "Dropbox Sign sending could not be updated.",
    );
  }
}

export async function disconnectDropboxSignAction(
  operatorConfirmed: boolean,
): Promise<Result<EsignDisconnectResult>> {
  try {
    const membership = await currentMembership();
    requireOwner(membership);
    if (operatorConfirmed !== true) {
      throw new ValidationError(
        "Confirm the Dropbox Sign disconnect before it is applied.",
      );
    }
    const { data, error } = await (
      createAdminClient() as unknown as AdminIntegrationClient
    ).rpc("disconnect_org_esign_integration", {
      p_org_id: membership.org_id,
      p_actor_id: membership.user_id,
    });
    const row = data?.[0];
    if (error || !row) {
      throw new DatabaseError(
        error?.code === "42883"
          ? "Dropbox Sign disconnect requires the latest database migration."
          : "Dropbox Sign disconnect state could not be confirmed.",
        { code: error?.code },
      );
    }
    revalidatePath("/settings/integrations");
    return ok({
      disconnected: row.disconnected,
      sendingEnabled: row.sending_enabled,
      credentialsPresent: row.credentials_present,
      message: row.message,
    });
  } catch (error) {
    reportError(error, { tags: { surface: "esign_disconnect" } });
    return safeEsignError(
      error,
      "ESIGN_DISCONNECT_FAILED",
      "Dropbox Sign could not be disconnected.",
    );
  }
}
