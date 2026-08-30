export const ESIGN_TEMPLATE_MERGE_FIELDS = [
  "seller_name",
  "property_address",
  "offer_price",
  "closing_date",
  "earnest_money",
] as const;

export type EsignTemplateMergeField =
  (typeof ESIGN_TEMPLATE_MERGE_FIELDS)[number];

export type TemplateSignerRole = Readonly<{
  name: string;
  order: number;
}>;

export type TemplateOption = Readonly<{
  id: string;
  name: string;
  documentType: string;
  providerTemplateId: string;
  signerRoles: readonly TemplateSignerRole[];
  sellerRoleName: string;
  mergeFieldNames: readonly EsignTemplateMergeField[];
}>;

export type EsignTemplateRow = TemplateOption &
  Readonly<{
    sourceFilename: string;
    sourceSizeBytes: number;
    pageCount: number | null;
    fieldCount: number | null;
    updatedAt: string;
    updatedByName: string;
    recentSendCount30d: number;
  }>;

export type TemplateLaneError = Readonly<{
  code: string;
  message: string;
}>;

export type TemplateLaneResult<T> =
  | Readonly<{ ok: true; data: T }>
  | Readonly<{ ok: false; error: TemplateLaneError }>;

export type TemplateLibraryLoadResult = TemplateLaneResult<
  readonly EsignTemplateRow[]
>;

export type TemplateSource = Readonly<{
  file: File;
  origin: "upload" | "dropbox";
}>;

export type CreateTemplateDraftInput = Readonly<{
  name: string;
  documentType: string;
  source: TemplateSource;
  signerRoles: readonly TemplateSignerRole[];
  sellerRoleName: string;
  mergeFieldNames: typeof ESIGN_TEMPLATE_MERGE_FIELDS;
}>;

export type TemplateLibraryActions = Readonly<{
  createDraft(
    input: CreateTemplateDraftInput,
  ): Promise<TemplateLaneResult<{ templateId: string }>>;
  pickDropboxPdf(): Promise<TemplateLaneResult<File | null>>;
  duplicateTemplate(
    templateId: string,
    name: string,
  ): Promise<TemplateLaneResult<{ templateId: string }>>;
  deleteTemplate(templateId: string): Promise<TemplateLaneResult<null>>;
}>;

export type EmbeddedTemplateSession = Readonly<{
  providerTemplateId: string;
  editUrl: string;
  expiresAt: number | null;
  clientId: string;
  skipDomainVerification: boolean;
}>;

export type TemplateEditorActions = Readonly<{
  startEditor(): Promise<TemplateLaneResult<EmbeddedTemplateSession>>;
  syncFinishedTemplate(): Promise<TemplateLaneResult<TemplateOption>>;
  abandonDraft(): Promise<TemplateLaneResult<null>>;
}>;

export type TemplateEditorData = Readonly<{
  id: string;
  name: string;
  sourceFilename: string;
  sourceSizeBytes: number;
  pageCount: number | null;
  fieldCount: number | null;
  isFinalized: boolean;
}>;
