import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import {
  createEsignWebhookDatabaseAdapter,
  type EsignWebhookRpcClient,
} from "./database-adapter";
import {
  getEsignCredentials,
} from "./credentials";
import { createDropboxSignProvider } from "./dropbox-sign";
import type { EsignWebhookDependencies } from "./ports";
import { createDropboxSignEventAuthenticator } from "./webhook-handler";

type AdminClient = SupabaseClient<Database>;

export function createConcreteDropboxSignWebhookDependencies(
  client: AdminClient = createAdminClient(),
): EsignWebhookDependencies {
  const database = createEsignWebhookDatabaseAdapter(
    createSupabaseEsignWebhookRpcClient(client),
  );

  const loadActiveCredentials = async (input: {
    orgId: string;
    callbackConsumerId: string;
  }) => {
    if (!(await integrationOwnsActiveConsumer(client, input))) return null;
    return getEsignCredentials(input.orgId);
  };

  return {
    secretResolver: {
      async resolvePathSecretHash(secretHash) {
        const { data: consumer, error } = await client
          .from("webhook_consumers")
          .select("id, org_id")
          .eq("secret_hash", secretHash)
          .eq("consumer_type", "esign_provider")
          .eq("enabled", true)
          .is("revoked_at", null)
          .maybeSingle();
        if (error) throw new SafeEsignServerError("CONSUMER_LOOKUP_FAILED");
        if (!consumer) return null;
        const identity = {
          orgId: consumer.org_id,
          callbackConsumerId: consumer.id,
        };
        return (await integrationOwnsActiveConsumer(client, identity))
          ? identity
          : null;
      },
    },
    authenticator: createDropboxSignEventAuthenticator({
      loadCredentials: loadActiveCredentials,
    }),
    persistence: database,
    metadataProvider: {
      async confirmProviderLocalRequestId(input) {
        const credentials = await loadActiveCredentials(input);
        if (!credentials) {
          throw new SafeEsignServerError("ACTIVE_CREDENTIALS_NOT_FOUND");
        }
        const metadata = await createDropboxSignProvider({
          apiKey: credentials.apiKey,
          clientId: credentials.clientId,
        }).getSignatureRequestMetadata(input.signRequestId);
        if (
          metadata.signatureRequestId !== input.signRequestId ||
          metadata.localRequestId !== input.localRequestId
        ) {
          return "mismatch";
        }
        if (metadata.testMode === null) return "mode_unverified";
        return input.testMode === null || metadata.testMode === input.testMode
          ? "matched"
          : "mismatch";
      },
    },
    pdfProvider: {
      async downloadSignedPdf(input) {
        const credentials = await loadActiveCredentials(input);
        if (!credentials) {
          throw new SafeEsignServerError("ACTIVE_CREDENTIALS_NOT_FOUND");
        }
        return createDropboxSignProvider({
          apiKey: credentials.apiKey,
          clientId: credentials.clientId,
        }).downloadSignedPdf(input.signRequestId);
      },
    },
    artifactPersistence: {
      async storeLinkAndRecordReady(input) {
        const { error } = await client.storage
          .from(input.artifact.storageBucket)
          .upload(input.artifact.storagePath, input.pdf, {
            contentType: input.artifact.contentType,
            upsert: false,
          });
        if (error && !isExistingObjectError(error)) {
          throw new SafeEsignServerError("SIGNED_PDF_UPLOAD_FAILED");
        }
        return database.linkSignedArtifact({
          orgId: input.orgId,
          requestId: input.requestId,
          claim: input.claim,
          templateTitle: input.templateTitle,
          artifact: input.artifact,
        });
      },
    },
  };
}

export function createSupabaseEsignWebhookRpcClient(
  client: AdminClient,
): EsignWebhookRpcClient {
  return {
    async rpc(name, args) {
      const result = await client.rpc(name, args as never);
      return result as Awaited<ReturnType<EsignWebhookRpcClient["rpc"]>>;
    },
  };
}

async function integrationOwnsActiveConsumer(
  client: AdminClient,
  input: { orgId: string; callbackConsumerId: string },
): Promise<boolean> {
  const [integration, consumer] = await Promise.all([
    client
      .from("org_esign_integrations")
      .select("org_id")
      .eq("org_id", input.orgId)
      .eq("callback_consumer_id", input.callbackConsumerId)
      .maybeSingle(),
    client
      .from("webhook_consumers")
      .select("id, org_id")
      .eq("id", input.callbackConsumerId)
      .eq("org_id", input.orgId)
      .eq("consumer_type", "esign_provider")
      .eq("enabled", true)
      .is("revoked_at", null)
      .maybeSingle(),
  ]);
  if (integration.error || consumer.error) {
    throw new SafeEsignServerError("INTEGRATION_LOOKUP_FAILED");
  }
  return integration.data?.org_id === input.orgId &&
    consumer.data?.id === input.callbackConsumerId &&
    consumer.data.org_id === input.orgId;
}

function isExistingObjectError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { statusCode?: string | number; status?: number };
  return candidate.statusCode === 409 || candidate.statusCode === "409" ||
    candidate.status === 409;
}

class SafeEsignServerError extends Error {
  constructor(readonly code: string) {
    super("The eSign webhook server operation failed.");
    this.name = "SafeEsignServerError";
  }
}
