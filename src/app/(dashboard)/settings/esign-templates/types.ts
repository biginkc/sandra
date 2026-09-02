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
  templateOrigin?: "sandra_embedded" | "dropbox_website";
    websiteTemplateStatus?: "valid" | "unavailable";
    websiteTemplateUnavailableReason?: string | null;
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
  lifecycle:
    "preparing" | "editing" | "cleanup_attention" | "provider_attention";
  kind?:
    | "copy"
    | "edit_revision"
    | "placement_restart"
    | "source_cleanup"
    | "provider_create";
  providerCreateState?: "unstarted" | "claimed" | "invoking" | "unknown" | "attached";
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

export type PreparedTemplateUpload = Readonly<{
  stagingSourceId: string;
  bucket: "esign-staging";
  storagePath: string;
}>;

export type PrepareTemplateUploadInput = Readonly<{
  stagingSourceId: string;
  filename: string;
  size: number;
  mimeType: "application/pdf";
  sha256: string;
}>;

export type StagedTemplateSourceReference = PreparedTemplateUpload &
  Readonly<{
    filename: string;
    size: number;
    mimeType: "application/pdf";
    sha256: string;
  }>;

export type CreateTemplateDraftActionInput = Omit<
  CreateTemplateDraftInput,
  "source"
> &
  Readonly<{
    source: StagedTemplateSourceReference &
      Readonly<{ origin: TemplateSource["origin"] }>;
  }>;

export type EmbeddedTemplateSession = Readonly<{
  providerTemplateId: string;
  editUrl: string;
  expiresAt: number | null;
  clientId: string;
}>;

export type CreatedTemplateDraft = Readonly<{
  templateId: string;
  initialEditorSession: EmbeddedTemplateSession | null;
}>;

export type RestartedTemplateDraft = Readonly<{
  templateId: string;
  initialEditorSession: EmbeddedTemplateSession;
  cleanupAttention: boolean;
}>;

export type RetriedTemplateDraft = Readonly<{
  templateId: string;
  initialEditorSession: EmbeddedTemplateSession;
}>;

export type TemplateLibraryActions = Readonly<{
  registerWebsiteTemplate?(input: {
    providerTemplateId: string;
    name: string;
    documentType: string;
  }): Promise<TemplateLaneResult<TemplateOption>>;
  revalidateWebsiteTemplate?(
    templateId: string,
    providerTemplateId: string,
  ): Promise<TemplateLaneResult<{ status: "valid" | "unavailable" }>>;
  createDraft(
    input: CreateTemplateDraftInput,
    options?: Readonly<{ signal?: AbortSignal; stagingSourceId?: string }>,
  ): Promise<TemplateLaneResult<CreatedTemplateDraft>>;
  pickDropboxPdf(): Promise<TemplateLaneResult<File | null>>;
  duplicateTemplate(
    templateId: string,
    name: string,
  ): Promise<
    TemplateLaneResult<{ templateId: string; readiness: "ready" | "pending" }>
  >;
  beginEditRevision(
    templateId: string,
  ): Promise<
    TemplateLaneResult<{ templateId: string; readiness: "ready" | "pending" }>
  >;
  checkEditorReadiness(
    templateId: string,
  ): Promise<TemplateLaneResult<{ readiness: "ready" | "pending" }>>;
  abandonDraft(templateId: string): Promise<TemplateLaneResult<null>>;
  retryCleanup(templateId: string): Promise<TemplateLaneResult<null>>;
  retrySourceCleanup?(sourceId: string): Promise<TemplateLaneResult<null>>;
  retryProviderCreate?(
    templateId: string,
  ): Promise<TemplateLaneResult<RetriedTemplateDraft>>;
  promoteStaleProviderCreate?(
    templateId: string,
  ): Promise<
    TemplateLaneResult<{
      templateId: string;
      providerCreateState: "unknown" | "attached";
    }>
  >;
  deleteTemplate(
    templateId: string,
    confirmRecentSends?: boolean,
  ): Promise<TemplateLaneResult<null>>;
}>;

export type TemplateEditorActions = Readonly<{
  startEditor(): Promise<TemplateLaneResult<EmbeddedTemplateSession>>;
  restartPlacement(): Promise<TemplateLaneResult<RestartedTemplateDraft>>;
  syncFinishedTemplate(
    input: Readonly<{ name: string }>,
  ): Promise<TemplateLaneResult<TemplateOption>>;
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
