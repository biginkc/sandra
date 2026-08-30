import {
  ESIGN_MERGE_FIELD_NAMES,
  type TemplateOption,
  type TemplateSignerRole,
} from "@/lib/esign/template-contract";

export {
  ESIGN_MERGE_FIELD_NAMES,
  ESIGN_TEMPLATE_MERGE_FIELDS,
  type EsignTemplateMergeField,
  type TemplateOption,
  type TemplateSignerRole,
} from "@/lib/esign/template-contract";

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

export type PendingTemplateCopy = Readonly<{
  id: string;
  name: string;
  lifecycle: "preparing" | "editing" | "cleanup_attention";
}>;

export type PendingTemplateCopiesLoadResult = TemplateLaneResult<
  readonly PendingTemplateCopy[]
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
  mergeFieldNames: typeof ESIGN_MERGE_FIELD_NAMES;
}>;

export type TemplateLibraryActions = Readonly<{
  createDraft(
    input: CreateTemplateDraftInput,
  ): Promise<TemplateLaneResult<{ templateId: string }>>;
  pickDropboxPdf(): Promise<TemplateLaneResult<File | null>>;
  duplicateTemplate(
    templateId: string,
    name: string,
  ): Promise<TemplateLaneResult<{ templateId: string; readiness: "ready" | "pending" }>>;
  checkEditorReadiness(
    templateId: string,
  ): Promise<TemplateLaneResult<{ readiness: "ready" | "pending" }>>;
  abandonDraft(templateId: string): Promise<TemplateLaneResult<null>>;
  retryCleanup(templateId: string): Promise<TemplateLaneResult<null>>;
  deleteTemplate(templateId: string, confirmRecentSends?: boolean): Promise<TemplateLaneResult<null>>;
}>;

export type EmbeddedTemplateSession = Readonly<{
  providerTemplateId: string;
  editUrl: string;
  expiresAt: number | null;
  clientId: string;
}>;

export type TemplateEditorActions = Readonly<{
  startEditor(): Promise<TemplateLaneResult<EmbeddedTemplateSession>>;
  syncFinishedTemplate(input: Readonly<{ name: string }>): Promise<TemplateLaneResult<TemplateOption>>;
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
