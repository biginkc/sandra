"use server";

import { revalidatePath } from "next/cache";

import { getCallerMemberships, type Membership } from "@/lib/auth/memberships";
import {
  AuthorizationError,
  DatabaseError,
  ProviderError,
  ValidationError,
} from "@/lib/errors/classes";
import {
  err,
  ok,
  type AppErrorShape,
  type Result,
} from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import type { EsignConnectionStatus } from "./contracts";
import {
  configuredDropboxSignClientId,
  configuredDropboxSignEmbeddedDomain,
  deleteEsignCredentials,
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
            api_key_last_four: string;
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
};

async function currentMembership(): Promise<Membership> {
  const memberships = await getCallerMemberships();
  if (memberships.length === 0) {
    throw new AuthorizationError("Sign in with active organization access.");
  }
  if (memberships.length !== 1) {
    throw new AuthorizationError(
      "Choose a single active organization before managing Dropbox Sign.",
    );
  }
  return memberships[0];
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
    return ok({
      connected: Boolean(data),
      canManage: membership.role === "owner",
      sendingEnabled: data?.sending_enabled ?? false,
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
): Promise<Result<null>> {
  try {
    const membership = await currentMembership();
    requireOwner(membership);
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

export async function disconnectDropboxSignAction(): Promise<Result<null>> {
  try {
    const membership = await currentMembership();
    requireOwner(membership);
    await deleteEsignCredentials(membership.org_id, membership.user_id);
    revalidatePath("/settings/integrations");
    return ok(null);
  } catch (error) {
    reportError(error, { tags: { surface: "esign_disconnect" } });
    return safeEsignError(
      error,
      "ESIGN_DISCONNECT_FAILED",
      "Dropbox Sign could not be disconnected.",
    );
  }
}
