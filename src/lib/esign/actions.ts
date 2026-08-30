"use server";

import { revalidatePath } from "next/cache";

import { getCallerMemberships, type Membership } from "@/lib/auth/memberships";
import {
  AuthorizationError,
  DatabaseError,
  ValidationError,
} from "@/lib/errors/classes";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
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
      eq(column: "org_id", value: string): {
        maybeSingle(): Promise<{
          data:
            | {
                api_key_last_four: string;
                sending_enabled: boolean;
                test_mode: boolean;
              }
            | null;
          error: { message: string; code?: string } | null;
        }>;
      };
    };
  };
};

type AdminIntegrationClient = {
  from(table: "org_esign_integrations"): {
    update(values: { sending_enabled: boolean; updated_by: string; updated_at: string }): {
      eq(column: "org_id", value: string): Promise<{
        error: { message: string; code?: string } | null;
      }>;
    };
  };
};

async function currentMembership(): Promise<Membership> {
  const memberships = await getCallerMemberships();
  if (memberships.length === 0) {
    throw new AuthorizationError("Sign in with active organization access.");
  }
  if (memberships.length > 1) {
    throw new AuthorizationError(
      "Choose one organization before managing Dropbox Sign.",
    );
  }
  return memberships[0];
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
    return errFromUnknown(error, "ESIGN_STATUS_FAILED");
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
    await provider.validateCredentials();
    await saveEsignCredentials({
      orgId: membership.org_id,
      actorId: membership.user_id,
      apiKey,
      clientId,
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
    return errFromUnknown(error, "ESIGN_CONNECT_FAILED");
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
    )
      .from("org_esign_integrations")
      .update({
        sending_enabled: enabled,
        updated_by: membership.user_id,
        updated_at: new Date().toISOString(),
      })
      .eq("org_id", membership.org_id);
    if (error) {
      throw new DatabaseError("Failed to update Dropbox Sign sending.", {
        code: error.code,
      });
    }
    revalidatePath("/settings/integrations");
    return ok(null);
  } catch (error) {
    reportError(error, { tags: { surface: "esign_sending_toggle" } });
    return errFromUnknown(error, "ESIGN_UPDATE_FAILED");
  }
}

export async function disconnectDropboxSignAction(): Promise<Result<null>> {
  try {
    const membership = await currentMembership();
    requireOwner(membership);
    await deleteEsignCredentials(membership.org_id);
    revalidatePath("/settings/integrations");
    return ok(null);
  } catch (error) {
    reportError(error, { tags: { surface: "esign_disconnect" } });
    return errFromUnknown(error, "ESIGN_DISCONNECT_FAILED");
  }
}
