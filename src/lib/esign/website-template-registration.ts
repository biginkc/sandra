import "server-only";

import { DatabaseError, ProviderError, ValidationError } from "@/lib/errors/classes";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

import {
  ESIGN_MERGE_FIELD_NAMES,
  ESIGN_TEMPLATE_SIGNER_ROLES,
  requireTemplateTitle,
  type ProviderTemplateField,
  type ProviderTemplateMetadata,
  type TemplateOption,
} from "./contracts";
import { getEsignCredentials } from "./credentials";
import { createDropboxSignProvider } from "./dropbox-sign";

type WebsiteRegistrationClient = {
  from(table: "esign_templates"): {
    select(columns: string): {
      eq(column: string, value: string): {
        eq(column: string, value: string): {
          maybeSingle(): Promise<{
            data: {
              id: string;
              org_id: string;
              name: string;
              document_type: string;
              provider_account_id: string | null;
              sign_template_id: string | null;
              template_origin: string;
            } | null;
            error: { message: string; code?: string } | null;
          }>;
        };
      };
    };
  };
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
    signerRoles: ESIGN_TEMPLATE_SIGNER_ROLES,
    mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
  };
}

export async function revalidateDropboxWebsiteTemplate(input: {
  orgId: string;
  actorId: string;
  templateId: string;
  providerTemplateId?: string;
}): Promise<"valid" | "unavailable"> {
  const credentials = await getEsignCredentials(input.orgId);
  if (!credentials) throw new Error("DROPBOX_SIGN_NOT_CONNECTED");
  const local = await loadLocalWebsiteTemplate(input);
  if (!local.sign_template_id) {
    await markUnavailable(input, "PROVIDER_METADATA_DRIFT");
    return "unavailable";
  }
  if (local.provider_account_id !== credentials.providerAccountId) {
    await markUnavailable(input, "PROVIDER_METADATA_DRIFT");
    return "unavailable";
  }
  const provider = createDropboxSignProvider({
    apiKey: credentials.apiKey,
    clientId: credentials.clientId,
  });
  let metadata: ProviderTemplateMetadata;
  try {
    metadata = await provider.getTemplate(local.sign_template_id);
    validateWebsiteProviderMetadata(
      metadata,
      local.sign_template_id,
      credentials.providerAccountId,
    );
  } catch (error) {
    if (isDefinitiveTemplateDrift(error)) {
      await markUnavailable(input, "PROVIDER_METADATA_DRIFT");
      return "unavailable";
    }
    throw error;
  }
  const admin = createAdminClient() as unknown as WebsiteRegistrationClient;
  const { error } = await admin.rpc("register_dropbox_website_esign_template", {
    p_org_id: input.orgId,
    p_actor_id: input.actorId,
    p_name: local.name,
    p_document_type: local.document_type,
    p_provider_account_id: credentials.providerAccountId,
    p_provider_template_id: metadata.providerTemplateId,
    p_provider_metadata: metadataForStorage(metadata),
  });
  if (error) {
    if (isIntegrityError(error.code)) {
      await markUnavailable(input, "PROVIDER_METADATA_DRIFT");
      return "unavailable";
    }
    throw new DatabaseError("Dropbox Sign template revalidation failed.", {
      code: error.code,
    });
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
  validateWebsiteProviderMetadata(
    metadata,
    providerTemplateId,
    credentials.providerAccountId,
  );
  return metadata;
}

async function loadLocalWebsiteTemplate(input: {
  orgId: string;
  templateId: string;
}) {
  const admin = createAdminClient() as unknown as WebsiteRegistrationClient;
  const { data, error } = await admin
    .from("esign_templates")
    .select("id,org_id,name,document_type,provider_account_id,sign_template_id,template_origin")
    .eq("org_id", input.orgId)
    .eq("id", input.templateId)
    .maybeSingle();
  if (error) {
    throw new DatabaseError("Dropbox Sign template revalidation failed.", {
      code: error.code,
    });
  }
  if (!data || data.template_origin !== "dropbox_website") {
    throw new DatabaseError("Dropbox Sign website template was not found.");
  }
  return data;
}

function validateWebsiteProviderMetadata(
  metadata: ProviderTemplateMetadata,
  expectedProviderTemplateId: string,
  expectedProviderAccountId: string,
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
  if (metadata.isLocked !== false) {
    throw new ProviderError(
      "Dropbox Sign template must be unlocked before Sandra can send it.",
      "dropbox_sign",
      { providerCode: "template_not_usable" },
    );
  }
  if (metadata.documents.length === 0) {
    throw new ProviderError(
      "Dropbox Sign template must include at least one document.",
      "dropbox_sign",
      { providerCode: "template_document_mismatch" },
    );
  }
  if (
    !metadata.accounts.some(
      (account) => account.accountId === expectedProviderAccountId,
    )
  ) {
    throw new ProviderError(
      "Dropbox Sign template is not available to the connected provider account.",
      "dropbox_sign",
      { providerCode: "template_account_mismatch" },
    );
  }
  if (JSON.stringify(metadata.signerRoles) !== JSON.stringify(ESIGN_TEMPLATE_SIGNER_ROLES)) {
    throw new ProviderError(
      "Dropbox Sign signer roles must be exactly Seller then Buyer.",
      "dropbox_sign",
      { providerCode: "signer_role_mismatch" },
    );
  }
  const customFields = metadata.documents.flatMap((document) => document.customFields);
  if (!hasExactSenderMergeFields(customFields)) {
    throw new ProviderError(
      "Dropbox Sign merge fields must exactly match Sandra's five Sender fields.",
      "dropbox_sign",
      { providerCode: "merge_field_mismatch" },
    );
  }
  if (!hasRequiredSignatureFields(metadata.formFields)) {
    throw new ProviderError(
      "Dropbox Sign template must include required signature fields for Seller and Buyer.",
      "dropbox_sign",
      { providerCode: "template_field_mismatch" },
    );
  }
}

function hasExactSenderMergeFields(fields: readonly ProviderTemplateField[]): boolean {
  const expectedFields = [...ESIGN_MERGE_FIELD_NAMES].sort();
  const expectedNameFields = fields.filter(
    (field) =>
      typeof field.name === "string" &&
      ESIGN_MERGE_FIELD_NAMES.includes(
        field.name as (typeof ESIGN_MERGE_FIELD_NAMES)[number],
      ),
  );
  const senderFields = fields.filter((field) => field.assignedTo === "sender");
  const actualFields = senderFields
    .filter(
      (field) =>
        isValidSenderMergeField(field) &&
        ESIGN_MERGE_FIELD_NAMES.includes(
          field.name as (typeof ESIGN_MERGE_FIELD_NAMES)[number],
        ),
    )
    .map((field) => field.name as string)
    .sort();
  return (
    expectedNameFields.length === expectedFields.length &&
    senderFields.length === expectedFields.length &&
    actualFields.length === expectedFields.length &&
    actualFields.every((field, index) => field === expectedFields[index])
  );
}

function isValidSenderMergeField(field: ProviderTemplateField): boolean {
  return (
    field.assignedTo === "sender" &&
    field.type === "text" &&
    typeof field.apiId === "string" &&
    field.apiId.trim().length > 0 &&
    typeof field.name === "string"
  );
}

function hasRequiredSignatureFields(fields: readonly ProviderTemplateField[]): boolean {
  const rolesWithRequiredSignature = new Set(
    fields
      .filter((field) =>
        field.assignedTo === "signer" &&
        field.type === "signature" &&
        field.required === true &&
        field.signerRoleName !== null &&
        typeof field.apiId === "string" &&
        field.apiId.trim().length > 0,
      )
      .map((field) => field.signerRoleName),
  );
  return ESIGN_TEMPLATE_SIGNER_ROLES.every((role) =>
    rolesWithRequiredSignature.has(role.name),
  );
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
  reason: string,
): Promise<void> {
  const admin = createAdminClient() as unknown as WebsiteRegistrationClient;
  const { error } = await admin.rpc("mark_dropbox_website_esign_template_unavailable", {
    p_org_id: input.orgId,
    p_actor_id: input.actorId,
    p_template_id: input.templateId,
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
    canEdit: metadata.canEdit,
    isCreator: metadata.isCreator,
    isLocked: metadata.isLocked,
    accounts: metadata.accounts.map((account) => ({ ...account })),
    signerRoles: metadata.signerRoles.map((role) => ({ ...role })),
    mergeFieldNames: [...metadata.mergeFieldNames],
    documents: metadata.documents.map((document) => ({
      index: document.index,
      name: document.name,
      customFields: document.customFields.map((field) => ({ ...field })),
      formFields: document.formFields.map((field) => ({ ...field })),
    })),
    mergeFields: metadata.mergeFields.map((field) => ({ ...field })),
    formFields: metadata.formFields.map((field) => ({ ...field })),
  };
}

function isDefinitiveTemplateDrift(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  const statusCode =
    typeof error.details?.statusCode === "number" ? error.details.statusCode : null;
  const providerCode =
    typeof error.details?.providerCode === "string"
      ? error.details.providerCode
      : null;
  if (statusCode === 404) return true;
  if (statusCode === 429 || (statusCode !== null && statusCode >= 500)) {
    return false;
  }
  return [
    "template_id_mismatch",
    "embedded_template_not_supported",
    "template_not_usable",
    "template_account_mismatch",
    "signer_role_mismatch",
    "merge_field_mismatch",
    "template_document_mismatch",
    "template_field_mismatch",
  ].includes(providerCode ?? "");
}

function isIntegrityError(code: string | undefined): boolean {
  return typeof code === "string" && code.startsWith("23");
}
