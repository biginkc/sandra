export const ESIGN_STATUSES = [
  "awaiting",
  "viewed",
  "signed",
  "declined",
  "voided",
  "error",
] as const;

export type EsignStatus = (typeof ESIGN_STATUSES)[number];

export const ESIGN_DELIVERY_STATES = [
  "sending",
  "sent",
  "send_unknown",
  "failed",
] as const;

export type EsignDeliveryState = (typeof ESIGN_DELIVERY_STATES)[number];

export type EsignSigner = {
  role: string;
  name: string;
  emailAddress: string;
};

export const ESIGN_MERGE_FIELD_NAMES = [
  "seller_name",
  "property_address",
  "offer_price",
  "closing_date",
  "earnest_money",
] as const;

export const ESIGN_TEMPLATE_MERGE_FIELDS = ESIGN_MERGE_FIELD_NAMES;
export const ESIGN_TEMPLATE_TITLE_MAX_LENGTH = 160;

export type EsignMergeFieldName =
  (typeof ESIGN_MERGE_FIELD_NAMES)[number];
export type EsignTemplateMergeField = EsignMergeFieldName;

export type TemplateSignerRole = {
  name: string;
  order: number;
};

export type TemplateOption = {
  id: string;
  name: string;
  documentType: string;
  providerTemplateId: string;
  sellerRoleName: string;
  signerRoles: readonly TemplateSignerRole[];
  mergeFieldNames: typeof ESIGN_MERGE_FIELD_NAMES;
};

export function validateTemplateTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  return title.length >= 1 && title.length <= ESIGN_TEMPLATE_TITLE_MAX_LENGTH
    ? title
    : null;
}

export function requireTemplateTitle(value: unknown): string {
  const title = validateTemplateTitle(value);
  if (!title) throw new Error("Invalid eSign template title.");
  return title;
}

export type EmbeddedTemplateSession = {
  providerTemplateId: string;
  editUrl: string;
  expiresAt: number | null;
};

export type ProviderTemplateMetadata = {
  providerTemplateId: string;
  localTemplateId: string | null;
  title: string | null;
  signerRoles: TemplateSignerRole[];
  mergeFieldNames: string[];
};

export type TemplatePdf = {
  filename: string;
  bytes: Buffer;
};

export type CreateEmbeddedTemplateDraftInput = {
  localTemplateId: string;
  title: string;
  file: TemplatePdf;
  signerRoles: readonly TemplateSignerRole[];
  mergeFieldNames: typeof ESIGN_MERGE_FIELD_NAMES;
};

export type SendWithTemplateInput = {
  localRequestId: string;
  templateId: string;
  signers: EsignSigner[];
  mergeValues: Record<string, string>;
  title?: string;
  subject?: string;
  message?: string;
  signal?: AbortSignal;
};

export type ProviderSignature = {
  signatureId: string;
  role: string;
  name: string;
  emailAddress: string;
  order: number;
};

export type SendWithTemplateOutput = {
  signatureRequestId: string;
  signatures: ProviderSignature[];
  detailsUrl: string | null;
  testMode: true;
};

export type DropboxSignProvider = {
  validateCredentials(): Promise<{
    accountId: string | null;
    clientId: string;
    domains: string[];
  }>;
  createEmbeddedTemplateDraft(
    input: CreateEmbeddedTemplateDraftInput,
  ): Promise<EmbeddedTemplateSession>;
  getEmbeddedTemplateEditUrl(
    providerTemplateId: string,
  ): Promise<EmbeddedTemplateSession>;
  getTemplate(providerTemplateId: string): Promise<ProviderTemplateMetadata>;
  getTemplateFiles(providerTemplateId: string): Promise<Buffer>;
  duplicateTemplate(
    providerTemplateId: string,
    file: TemplatePdf,
  ): Promise<{ providerTemplateId: string; readiness: "ready" | "pending" }>;
  updateTemplateFiles(
    providerTemplateId: string,
    file: TemplatePdf,
  ): Promise<void>;
  deleteTemplate(providerTemplateId: string): Promise<void>;
  sendWithTemplate(input: SendWithTemplateInput): Promise<SendWithTemplateOutput>;
  remind(
    signatureRequestId: string,
    signer: { emailAddress: string; name?: string },
    signal?: AbortSignal,
  ): Promise<void>;
  cancel(signatureRequestId: string, signal?: AbortSignal): Promise<void>;
  downloadSignedPdf(signatureRequestId: string): Promise<Buffer>;
};

export type EsignConnectionStatus = {
  connected: boolean;
  canManage: boolean;
  sendingEnabled: boolean;
  testMode: true;
  apiKeyLastFour: string | null;
};
