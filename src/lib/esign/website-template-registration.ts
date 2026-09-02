import "server-only";

import { DatabaseError, ProviderError, ValidationError } from "@/lib/errors/classes";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

import {
  ESIGN_MERGE_FIELD_NAMES,
  requireTemplateTitle,
  type ProviderTemplateMetadata,
  type TemplateOption,
  type TemplateSignerRole,
} from "./contracts";
import { getEsignCredentials } from "./credentials";
import { createDropboxSignProvider } from "./dropbox-sign";

const WEBSITE_SIGNER_ROLES: readonly TemplateSignerRole[] = [
  { name: "Seller", order: 0 },
];

type WebsiteRegistrationClient = {
  rpc(
    fn: "register_dropbox_website_esign_template",
    args: {
      p_org_id: string;
      p_actor_id: string;
      p_name: string;
      p_document_type: string;
      p_provider_account_id: string;
      p_provider_template_id: string;
      p_provider_metadata: Json;
    },
  ): Promise<{
    data: Array<{ outcome: string; template_id: string }> | null;
    error: { message: string; code?: string } | null;
  }>;
  rpc(
    fn: "mark_dropbox_website_esign_template_unavailable",
    args: {
      p_org_id: string;
      p_actor_id: string;
      p_template_id: string;
      p_provider_template_id: string;
      p_reason: string;
    },
  ): Promise<{ error: { message: string; code?: string } | null }>;
};

export type WebsiteTemplateRegistrationInput = Readonly<{
  orgId: string;
  actorId: string;
  providerTemplateId: string;
  name: string;
  documentType: string;
}>;

export async function registerDropboxWebsiteTemplate(
  input: WebsiteTemplateRegistrationInput,
): Promise<TemplateOption> {
  const metadata = await readAndValidateWebsiteTemplate(input);
  const row = await registerAttestedTemplate(input, metadata);
  return {
    id: row.templateId,
    name: requireTemplateTitle(input.name),
    documentType: input.documentType.trim(),
    providerTemplateId: metadata.providerTemplateId,
    sellerRoleName: "Seller",
    signerRoles: WEBSITE_SIGNER_ROLES,
    mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
  };
}

export async function revalidateDropboxWebsiteTemplate(input: {
  orgId: string;
  actorId: string;
  templateId: string;
  providerTemplateId: string;
}): Promise<"valid" | "unavailable"> {
  const credentials = await getEsignCredentials(input.orgId);
  if (!credentials) throw new Error("DROPBOX_SIGN_NOT_CONNECTED");
  const provider = createDropboxSignProvider({
    apiKey: credentials.apiKey,
    clientId: credentials.clientId,
  });
  let metadata: ProviderTemplateMetadata;
  try {
    metadata = await provider.getTemplate(input.providerTemplateId);
    validateWebsiteProviderMetadata(metadata, input.providerTemplateId);
  } catch (error) {
    await markUnavailable(input, providerMetadataForFailure(input.providerTemplateId), "PROVIDER_METADATA_DRIFT");
    if (error instanceof ProviderError) return "unavailable";
    throw error;
  }
  const admin = createAdminClient() as unknown as WebsiteRegistrationClient;
  const { error } = await admin.rpc("register_dropbox_website_esign_template", {
    p_org_id: input.orgId,
    p_actor_id: input.actorId,
    p_name: metadata.title ?? "Dropbox Sign template",
    p_document_type: "Purchase agreement",
    p_provider_account_id: credentials.providerAccountId,
    p_provider_template_id: metadata.providerTemplateId,
    p_provider_metadata: metadataForStorage(metadata),
  });
  if (error) {
    await markUnavailable(input, metadataForStorage(metadata), "PROVIDER_METADATA_DRIFT");
    return "unavailable";
  }
  return "valid";
}

async function readAndValidateWebsiteTemplate(
  input: WebsiteTemplateRegistrationInput,
): Promise<ProviderTemplateMetadata> {
  const name = requireTemplateTitle(input.name);
  if (input.name !== name || !input.documentType.trim()) {
    throw new ValidationError("Template label and document type are required.");
  }
  const providerTemplateId = input.providerTemplateId.trim();
  if (!providerTemplateId) {
    throw new ValidationError("Enter a Dropbox Sign template ID.");
  }
  const credentials = await getEsignCredentials(input.orgId);
  if (!credentials) throw new Error("DROPBOX_SIGN_NOT_CONNECTED");
  const metadata = await createDropboxSignProvider({
    apiKey: credentials.apiKey,
    clientId: credentials.clientId,
  }).getTemplate(providerTemplateId);
  validateWebsiteProviderMetadata(metadata, providerTemplateId);
  return metadata;
}

function validateWebsiteProviderMetadata(
  metadata: ProviderTemplateMetadata,
  expectedProviderTemplateId: string,
): void {
  if (metadata.providerTemplateId !== expectedProviderTemplateId) {
    throw new ProviderError(
      "Dropbox Sign returned a different template ID.",
      "dropbox_sign",
      { providerCode: "template_id_mismatch" },
    );
  }
  if (metadata.isEmbedded !== false) {
    throw new ProviderError(
      "Register a non-embedded Dropbox Sign website template.",
      "dropbox_sign",
      { providerCode: "embedded_template_not_supported" },
    );
  }
  if (JSON.stringify(metadata.signerRoles) !== JSON.stringify(WEBSITE_SIGNER_ROLES)) {
    throw new ProviderError(
      "Dropbox Sign signer roles must be exactly Seller at order 1.",
      "dropbox_sign",
      { providerCode: "signer_role_mismatch" },
    );
  }
  const actualFields = [...new Set(metadata.mergeFieldNames)].sort();
  const expectedFields = [...ESIGN_MERGE_FIELD_NAMES].sort();
  if (
    actualFields.length !== expectedFields.length ||
    actualFields.some((field, index) => field !== expectedFields[index])
  ) {
    throw new ProviderError(
      "Dropbox Sign merge fields must exactly match Sandra's five fields.",
      "dropbox_sign",
      { providerCode: "merge_field_mismatch" },
    );
  }
}

async function registerAttestedTemplate(
  input: WebsiteTemplateRegistrationInput,
  metadata: ProviderTemplateMetadata,
): Promise<{ outcome: string; templateId: string }> {
  const credentials = await getEsignCredentials(input.orgId);
  if (!credentials) throw new Error("DROPBOX_SIGN_NOT_CONNECTED");
  const admin = createAdminClient() as unknown as WebsiteRegistrationClient;
  const { data, error } = await admin.rpc("register_dropbox_website_esign_template", {
    p_org_id: input.orgId,
    p_actor_id: input.actorId,
    p_name: requireTemplateTitle(input.name),
    p_document_type: input.documentType.trim(),
    p_provider_account_id: credentials.providerAccountId,
    p_provider_template_id: metadata.providerTemplateId,
    p_provider_metadata: metadataForStorage(metadata),
  });
  if (error) {
    throw new DatabaseError("Dropbox Sign template registration failed.", {
      code: error.code,
    });
  }
  const row = data?.[0];
  if (!row?.template_id) {
    throw new DatabaseError("Dropbox Sign template registration was not confirmed.");
  }
  return { outcome: row.outcome, templateId: row.template_id };
}

async function markUnavailable(
  input: { orgId: string; actorId: string; templateId: string },
  metadata: Json,
  reason: string,
): Promise<void> {
  const admin = createAdminClient() as unknown as WebsiteRegistrationClient;
  const { error } = await admin.rpc("mark_dropbox_website_esign_template_unavailable", {
    p_org_id: input.orgId,
    p_actor_id: input.actorId,
    p_template_id: input.templateId,
    p_provider_template_id: String(
      (metadata as { providerTemplateId?: unknown }).providerTemplateId ?? "",
    ),
    p_reason: reason,
  });
  if (error) {
    throw new DatabaseError("Dropbox Sign template revalidation failed.", {
      code: error.code,
    });
  }
}

function metadataForStorage(metadata: ProviderTemplateMetadata): Json {
  return {
    providerTemplateId: metadata.providerTemplateId,
    title: metadata.title,
    isEmbedded: metadata.isEmbedded,
    signerRoles: metadata.signerRoles.map((role) => ({ ...role })),
    mergeFieldNames: [...metadata.mergeFieldNames],
  };
}

function providerMetadataForFailure(providerTemplateId: string): Json {
  return {
    providerTemplateId,
    unavailable: true,
  };
}
