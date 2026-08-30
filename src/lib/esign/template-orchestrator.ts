import {
  ESIGN_TEMPLATE_MERGE_FIELDS,
  requireTemplateTitle,
  type TemplateOption,
  type TemplateSignerRole,
} from "./template-contract";

export const ESIGN_TEMPLATE_MAX_PDF_BYTES = 40 * 1024 * 1024;
export const ESIGN_TEMPLATE_STAGING_BUCKET = "esign-staging" as const;

export type TemplateActionError = Readonly<{ code: string; message: string }>;
export type TemplateActionResult<T> =
  | Readonly<{ ok: true; data: T }>
  | Readonly<{ ok: false; error: TemplateActionError }>;

export type TemplateActor = Readonly<{
  userId: string;
  orgId: string;
  isOwner: boolean;
}>;

export type TemplateListItem = TemplateOption & Readonly<{
  sourceFilename: string;
  sourceSizeBytes: number;
  pageCount: number | null;
  fieldCount: number | null;
  updatedAt: string;
  updatedByName: string;
  recentSendCount30d: number;
}>;

export type PendingTemplateCopy = Readonly<{
  id: string;
  orgId: string;
  name: string;
  lifecycle: "preparing" | "editing" | "cleanup_attention";
  kind?: "copy" | "edit_revision";
}>;

export type TemplateUpload = Readonly<{
  filename: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}>;

export type StagedTemplateSource = Readonly<{
  id: string;
  orgId: string;
  storagePath: string;
  filename: string;
  size: number;
  mimeType: "application/pdf";
  sha256: string;
}>;

export type StagedTemplateSourceReference = Readonly<{
  stagingSourceId: string;
  bucket: string;
  storagePath: string;
  filename: string;
  size: number;
  mimeType: string;
  sha256: string;
}>;

export type TemplateDraftRecord = Readonly<{
  id: string;
  orgId: string;
  name: string;
  documentType: string;
  providerTemplateId: string | null;
  providerAccountId?: string | null;
  sellerRoleName: string;
  signerRoles: readonly TemplateSignerRole[];
  mergeFieldNames: readonly string[];
  stagingSourceId: string | null;
  supersedesTemplateId: string | null;
  lifecycle: "preparing" | "editing" | "finalized" | "abandoned" | "deleted" | "error";
}>;

export type ProviderTemplateState = Readonly<{
  providerTemplateId: string;
  signerRoles: readonly TemplateSignerRole[];
  mergeFieldNames: readonly string[];
}>;

export type TemplateAuthPort = Readonly<{
  getActor(): Promise<TemplateActor | null>;
}>;

export type TemplateRepositoryPort = Readonly<{
  listFinalized(orgId: string): Promise<readonly TemplateListItem[]>;
  listPendingCopies(orgId: string): Promise<readonly PendingTemplateCopy[]>;
  recordVerifiedStage(input: StagedTemplateSource): Promise<StagedTemplateSource>;
  recordUnattachedStageCleanup(input: { orgId: string; stageId: string; outcome: "deleted" | "failed" }): Promise<void>;
  getStage(orgId: string, stageId: string): Promise<StagedTemplateSource | null>;
  createHiddenDraft(input: Omit<TemplateDraftRecord, "id" | "providerTemplateId" | "supersedesTemplateId" | "lifecycle">): Promise<TemplateDraftRecord>;
  createHiddenDuplicate(input: { orgId: string; sourceTemplateId: string; name: string }): Promise<TemplateDraftRecord>;
  createHiddenEditRevision(input: { orgId: string; sourceTemplateId: string; stagingSourceId: string }): Promise<TemplateDraftRecord>;
  getTemplate(orgId: string, templateId: string): Promise<TemplateDraftRecord | null>;
  attachProviderId(orgId: string, templateId: string, providerTemplateId: string): Promise<boolean>;
  finalizeDraft(input: {
    orgId: string;
    templateId: string;
    expectedProviderTemplateId: string;
    option: TemplateOption;
  }): Promise<boolean>;
  publishEditRevision(input: {
    orgId: string;
    sourceTemplateId: string;
    revisionTemplateId: string;
    expectedSourceProviderTemplateId: string;
    revisionProviderTemplateId: string;
    option: TemplateOption;
  }): Promise<"published" | "already_published" | null>;
  markAbandoned(orgId: string, templateId: string): Promise<boolean>;
  softDelete(orgId: string, templateId: string, confirmRecentSends: boolean): Promise<{ outcome: "deleted" | "already_deleted" | "needs_confirmation"; recentSendCount: number }>;
  recordSourceCleanup(input: {
    orgId: string;
    templateId: string;
    storagePath: string;
    outcome: "deleted" | "failed";
  }): Promise<void>;
}>;

export type TemplatePrivateStoragePort = Readonly<{
  putPrivate(path: string, bytes: Uint8Array, mimeType: "application/pdf"): Promise<void>;
  readPrivate(path: string): Promise<Uint8Array>;
  deletePrivate(path: string): Promise<"deleted" | "already_absent">;
}>;

export type TemplateProviderPort = Readonly<{
  getEmbeddedClientId(): Promise<string>;
  createDraft(input: {
    localTemplateId: string;
    title: string;
    documentType: string;
    file: TemplateUpload;
    signerRoles: readonly TemplateSignerRole[];
    mergeFieldNames: typeof ESIGN_TEMPLATE_MERGE_FIELDS;
  }): Promise<{ providerTemplateId: string }>;
  getFreshEditUrl(providerTemplateId: string): Promise<{ editUrl: string; expiresAt: number | null }>;
  getTemplate(providerTemplateId: string): Promise<ProviderTemplateState>;
  getTemplateFiles(providerTemplateId: string): Promise<Uint8Array>;
  duplicateTemplate(input: {
    providerTemplateId: string;
    expectedProviderAccountId: string;
    title: string;
  }): Promise<{ providerTemplateId: string; readiness: "ready" | "pending" }>;
  deleteTemplate(providerTemplateId: string): Promise<void>;
  isNotFound(error: unknown): boolean;
  isAmbiguousMutation(error: unknown): boolean;
}>;

export type TemplateOrchestratorPorts = Readonly<{
  auth: TemplateAuthPort;
  repository: TemplateRepositoryPort;
  storage: TemplatePrivateStoragePort;
  provider: TemplateProviderPort;
  randomId(): string;
  now(): Date;
}>;

export function createTemplateOrchestrator(ports: TemplateOrchestratorPorts) {
  async function owner(): Promise<TemplateActionResult<TemplateActor>> {
    let actor: TemplateActor | null;
    try {
      actor = await ports.auth.getActor();
    } catch {
      return failure("AUTH_CHECK_FAILED", "Template access could not be verified.");
    }
    if (!actor) return failure("AUTH_REQUIRED", "Sign in to manage eSign templates.");
    if (!actor.isOwner) return failure("OWNER_REQUIRED", "Only an organization owner can manage eSign templates.");
    return success(actor);
  }

  return {
    async list(): Promise<TemplateActionResult<readonly TemplateListItem[]>> {
      const access = await owner();
      if (!access.ok) return access;
      try {
        return success(await ports.repository.listFinalized(access.data.orgId));
      } catch {
        return failure("TEMPLATE_LIST_FAILED", "Templates could not be loaded.");
      }
    },

    async listPendingCopies(): Promise<TemplateActionResult<readonly PendingTemplateCopy[]>> {
      const access = await owner();
      if (!access.ok) return access;
      try {
        const copies = await ports.repository.listPendingCopies(access.data.orgId);
        if (copies.some((copy) => copy.orgId !== access.data.orgId)) {
          return failure("PENDING_COPY_SCOPE_MISMATCH", "Pending template copies could not be loaded safely.");
        }
        return success(copies);
      } catch {
        return failure("PENDING_COPY_LIST_FAILED", "Pending template copies could not be loaded.");
      }
    },

    async verifyStagedSource(input: StagedTemplateSourceReference): Promise<TemplateActionResult<{ stagingSourceId: string }>> {
      const access = await owner();
      if (!access.ok) return access;
      if (!isOpaqueId(input.stagingSourceId)
        || input.bucket !== ESIGN_TEMPLATE_STAGING_BUCKET
        || input.storagePath !== stagingPath(access.data.orgId, input.stagingSourceId)) {
        return failure("STAGING_SOURCE_INVALID", "The private PDF source is unavailable.");
      }
      if (!isSafeSourceFilename(input.filename)
        || input.mimeType !== "application/pdf"
        || input.size <= 0
        || input.size > ESIGN_TEMPLATE_MAX_PDF_BYTES
        || !/^[a-f0-9]{64}$/.test(input.sha256)) {
        return failure("STAGING_METADATA_INVALID", "The private PDF metadata is invalid. Its reservation remains available for safe cleanup.");
      }
      let bytes: Uint8Array;
      try {
        bytes = await ports.storage.readPrivate(input.storagePath);
      } catch {
        return failure("STAGING_VERIFY_READ_FAILED", "The private PDF could not be verified after upload. Its reservation remains available for safe cleanup.");
      }
      const validated = validateOnePdf([{
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.size,
        bytes,
      }]);
      const actualHash = await sha256Hex(bytes);
      if (!validated.ok || bytes.byteLength !== input.size || actualHash !== input.sha256) {
        return failure("STAGING_VERIFY_FAILED", "The stored PDF did not match the uploaded file. Its reservation remains available for safe cleanup.");
      }
      try {
        const stage = await ports.repository.recordVerifiedStage({
          id: input.stagingSourceId,
          orgId: access.data.orgId,
          storagePath: input.storagePath,
          filename: input.filename,
          size: input.size,
          mimeType: "application/pdf",
          sha256: actualHash,
        });
        return success({ stagingSourceId: stage.id });
      } catch {
        return failure("STAGING_RECORD_FAILED", "The private upload could not be recorded. Its reservation remains available for safe cleanup.");
      }
    },

    async beginEditRevision(sourceTemplateId: string): Promise<TemplateActionResult<{ templateId: string; readiness: "ready" | "pending" }>> {
      const access = await owner();
      if (!access.ok) return access;
      let source: TemplateDraftRecord | null;
      try {
        source = await ports.repository.getTemplate(access.data.orgId, sourceTemplateId);
      } catch {
        return failure("TEMPLATE_READ_FAILED", "The template could not be loaded.");
      }
      if (!source || source.orgId !== access.data.orgId || source.lifecycle !== "finalized" || !source.providerTemplateId || !source.providerAccountId) {
        return failure("TEMPLATE_NOT_FOUND", "Only an active finalized template can be edited.");
      }
      let bytes: Uint8Array;
      try {
        bytes = await ports.provider.getTemplateFiles(source.providerTemplateId);
      } catch {
        return failure("EDIT_SOURCE_DOWNLOAD_FAILED", "Dropbox Sign could not prepare the template source for editing.");
      }
      const staged = await stageVerifiedSource(ports, access.data, {
        filename: `${source.name}.pdf`, mimeType: "application/pdf", size: bytes.byteLength, bytes,
      });
      if (!staged.ok) return staged;
      let revision: TemplateDraftRecord;
      try {
        revision = await ports.repository.createHiddenEditRevision({
          orgId: access.data.orgId,
          sourceTemplateId: source.id,
          stagingSourceId: staged.data.id,
        });
      } catch {
        await cleanupUnattachedStage(ports, staged.data);
        return failure("EDIT_REVISION_CREATE_FAILED", "Sandra could not prepare a hidden edit revision.");
      }
      let duplicate: { providerTemplateId: string; readiness: "ready" | "pending" };
      try {
        duplicate = await ports.provider.duplicateTemplate({ providerTemplateId: source.providerTemplateId, expectedProviderAccountId: source.providerAccountId, title: source.name });
      } catch {
        const compensated = await compensateHiddenDraft(ports, revision);
        return compensated
          ? failure("EDIT_PROVIDER_COPY_FAILED", "Dropbox Sign could not create the edit revision.")
          : failure("EDIT_COMPENSATION_FAILED", "The failed edit revision requires cleanup attention.");
      }
      if (!duplicate.providerTemplateId || duplicate.providerTemplateId === source.providerTemplateId) {
        await compensateHiddenDraft(ports, revision);
        return failure("EDIT_PROVIDER_ID_INVALID", "Dropbox Sign did not return a distinct edit revision.");
      }
      try {
        if (!(await ports.repository.attachProviderId(access.data.orgId, revision.id, duplicate.providerTemplateId))) throw new Error("attach failed");
      } catch {
        let providerRemoved = false;
        try { await ports.provider.deleteTemplate(duplicate.providerTemplateId); providerRemoved = true; }
        catch (error) { providerRemoved = ports.provider.isNotFound(error); }
        const compensated = await compensateHiddenDraft(ports, revision);
        return providerRemoved && compensated
          ? failure("EDIT_LOCAL_ATTACH_FAILED", "The provider edit revision was removed because Sandra could not record it.")
          : failure("EDIT_COMPENSATION_FAILED", "Sandra could not safely reconcile the edit revision.");
      }
      return success({ templateId: revision.id, readiness: duplicate.readiness });
    },

    async add(input: {
      stagingSourceId: string;
      name: string;
      documentType: string;
      signerRoles: readonly TemplateSignerRole[];
      sellerRoleName: string;
      mergeFieldNames: readonly string[];
    }): Promise<TemplateActionResult<{ templateId: string }>> {
      const access = await owner();
      if (!access.ok) return access;
      const contract = validateServerContract(input);
      if (!contract.ok) return contract;
      let stage: StagedTemplateSource | null;
      try {
        stage = await ports.repository.getStage(access.data.orgId, input.stagingSourceId);
      } catch {
        return failure("STAGING_SOURCE_READ_FAILED", "The private PDF source could not be verified.");
      }
      if (!stage || stage.orgId !== access.data.orgId || !isOrgScopedStagingPath(stage.storagePath, access.data.orgId)) {
        return failure("STAGING_SOURCE_INVALID", "The private PDF source is unavailable.");
      }
      let bytes: Uint8Array;
      try {
        bytes = await ports.storage.readPrivate(stage.storagePath);
      } catch {
        return failure("STAGING_SOURCE_READ_FAILED", "The private PDF source could not be read.");
      }
      const file = validateOnePdf([{ filename: stage.filename, mimeType: stage.mimeType, size: stage.size, bytes }]);
      if (!file.ok) return file;
      if (await sha256Hex(bytes) !== stage.sha256) {
        return failure("STAGING_SOURCE_HASH_MISMATCH", "The private PDF source no longer matches its verified upload.");
      }
      let draft: TemplateDraftRecord;
      try {
        draft = await ports.repository.createHiddenDraft({
          orgId: access.data.orgId,
          name: contract.data.name,
          documentType: input.documentType.trim(),
          signerRoles: contract.data.signerRoles,
          sellerRoleName: input.sellerRoleName,
          mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS,
          stagingSourceId: stage.id,
        });
      } catch {
        const cleanup = await cleanupUnattachedStage(ports, stage);
        return cleanup
          ? failure("DRAFT_CREATE_FAILED", "The hidden template draft could not be created.")
          : failure("DRAFT_CREATE_COMPENSATION_FAILED", "The hidden template draft failed and its private source requires cleanup.");
      }
      let providerTemplateId: string;
      try {
        ({ providerTemplateId } = await ports.provider.createDraft({
          localTemplateId: draft.id,
          title: contract.data.name,
          documentType: input.documentType.trim(),
          file: file.data,
          signerRoles: contract.data.signerRoles,
          mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS,
        }));
      } catch (error) {
        if (ports.provider.isAmbiguousMutation(error)) {
          return failure("PROVIDER_CREATE_RECONCILIATION_REQUIRED", "Dropbox Sign may have created the template. The hidden draft remains available for safe recovery.");
        }
        const compensated = await compensateHiddenDraft(ports, draft);
        if (!compensated) return failure("CREATE_COMPENSATION_FAILED", "The failed provider draft could not be safely reconciled.");
        return failure("PROVIDER_CREATE_FAILED", "Dropbox Sign could not create the template draft.");
      }
      if (!providerTemplateId) {
        const compensated = await compensateHiddenDraft(ports, draft);
        return compensated
          ? failure("PROVIDER_ID_MISSING", "Dropbox Sign did not return a template identifier.")
          : failure("CREATE_COMPENSATION_FAILED", "The incomplete provider draft could not be safely reconciled.");
      }
      try {
        if (await ports.repository.attachProviderId(access.data.orgId, draft.id, providerTemplateId)) {
          return success({ templateId: draft.id });
        }
      } catch {
        // Reconcile below. Never report success when the stable ID was not stored.
      }
      try {
        await ports.provider.deleteTemplate(providerTemplateId);
        if (!(await compensateHiddenDraft(ports, draft))) {
          return failure("CREATE_COMPENSATION_FAILED", "Sandra could not safely reconcile the failed provider draft.");
        }
        return failure("LOCAL_ATTACH_FAILED", "The provider draft was removed because Sandra could not record it.");
      } catch {
        return failure("CREATE_COMPENSATION_FAILED", "Sandra could not record or safely remove the provider draft.");
      }
    },

    async startEditor(templateId: string): Promise<TemplateActionResult<{
      providerTemplateId: string;
      editUrl: string;
      expiresAt: number | null;
      clientId: string;
    }>> {
      const access = await owner();
      if (!access.ok) return access;
      let template: TemplateDraftRecord | null;
      try {
        template = await ports.repository.getTemplate(access.data.orgId, templateId);
      } catch {
        return failure("TEMPLATE_READ_FAILED", "The template could not be loaded.");
      }
      if (!template || template.orgId !== access.data.orgId || template.lifecycle !== "editing") {
        return failure("TEMPLATE_NOT_FOUND", "The template is unavailable.");
      }
      if (!template.providerTemplateId) return failure("PROVIDER_ID_PENDING", "The template is still being prepared.");
      try {
        const provider = await ports.provider.getTemplate(template.providerTemplateId);
        if (provider.providerTemplateId !== template.providerTemplateId) {
          return failure("PROVIDER_ID_MISMATCH", "Dropbox Sign returned a different template identifier.");
        }
        const session = await ports.provider.getFreshEditUrl(template.providerTemplateId);
        const clientId = await ports.provider.getEmbeddedClientId();
        return success({
          providerTemplateId: template.providerTemplateId,
          editUrl: session.editUrl,
          expiresAt: session.expiresAt,
          clientId,
        });
      } catch {
        return failure("EDITOR_SESSION_FAILED", "Dropbox Sign could not open a fresh editor session.");
      }
    },

    async checkEditorReadiness(templateId: string): Promise<TemplateActionResult<{ readiness: "ready" | "pending" }>> {
      const access = await owner();
      if (!access.ok) return access;
      let template: TemplateDraftRecord | null;
      try {
        template = await ports.repository.getTemplate(access.data.orgId, templateId);
      } catch {
        return failure("TEMPLATE_READ_FAILED", "The template could not be loaded.");
      }
      if (!template || template.orgId !== access.data.orgId || !["preparing", "editing"].includes(template.lifecycle) || !template.providerTemplateId) {
        return failure("TEMPLATE_NOT_FOUND", "The template copy is unavailable.");
      }
      try {
        const provider = await ports.provider.getTemplate(template.providerTemplateId);
        if (provider.providerTemplateId !== template.providerTemplateId) {
          return failure("PROVIDER_ID_MISMATCH", "Dropbox Sign returned a different template identifier.");
        }
        return success({ readiness: "ready" });
      } catch (error) {
        if (ports.provider.isNotFound(error)) return success({ readiness: "pending" });
        return failure("DUPLICATE_READINESS_FAILED", "Dropbox Sign could not check whether the copy is ready.");
      }
    },

    async finishSync(templateId: string): Promise<TemplateActionResult<TemplateOption>> {
      const access = await owner();
      if (!access.ok) return access;
      let draft: TemplateDraftRecord | null;
      try {
        draft = await ports.repository.getTemplate(access.data.orgId, templateId);
      } catch {
        return failure("TEMPLATE_READ_FAILED", "The template could not be loaded.");
      }
      if (!draft || draft.orgId !== access.data.orgId || !["editing", "finalized"].includes(draft.lifecycle) || !draft.providerTemplateId) {
        return failure("DRAFT_STALE", "The template draft is no longer available to finalize.");
      }
      let provider: ProviderTemplateState;
      try {
        provider = await ports.provider.getTemplate(draft.providerTemplateId);
      } catch {
        return failure("PROVIDER_SYNC_FAILED", "Dropbox Sign template state could not be verified.");
      }
      const reconciled = reconcileOption(draft, provider);
      if (!reconciled.ok) return reconciled;
      try {
        const persisted = draft.supersedesTemplateId
          ? await publishRevision(ports, access.data.orgId, draft, reconciled.data)
          : await ports.repository.finalizeDraft({
              orgId: access.data.orgId,
              templateId,
              expectedProviderTemplateId: draft.providerTemplateId,
              option: reconciled.data,
            });
        if (!persisted) {
          return failure("DRAFT_STALE", "The template changed before it could be finalized.");
        }
      } catch {
        return failure("FINALIZE_LOCAL_FAILED", "Sandra could not finalize the verified template.");
      }
      if (draft.lifecycle === "editing" || (draft.lifecycle === "finalized" && Boolean(draft.supersedesTemplateId))) {
        const cleanup = await cleanupSource(ports, draft);
        if (!cleanup.ok) return cleanup;
      }
      return success(reconciled.data);
    },

    async abandon(templateId: string): Promise<TemplateActionResult<null>> {
      const access = await owner();
      if (!access.ok) return access;
      let draft: TemplateDraftRecord | null;
      try {
        draft = await ports.repository.getTemplate(access.data.orgId, templateId);
      } catch {
        return failure("TEMPLATE_READ_FAILED", "The template could not be loaded.");
      }
      if (!draft || draft.orgId !== access.data.orgId || !["preparing", "editing"].includes(draft.lifecycle)) return failure("DRAFT_STALE", "The template draft is no longer available.");
      if (draft.providerTemplateId) {
        try {
          await ports.provider.deleteTemplate(draft.providerTemplateId);
        } catch (error) {
          if (!ports.provider.isNotFound(error)) return failure("ABANDON_PROVIDER_FAILED", "Dropbox Sign could not remove the draft.");
        }
      }
      try {
        if (!(await ports.repository.markAbandoned(access.data.orgId, templateId))) {
          return failure("ABANDON_LOCAL_FAILED", "Sandra could not record the abandoned draft.");
        }
      } catch {
        return failure("ABANDON_LOCAL_FAILED", "Sandra could not record the abandoned draft.");
      }
      const cleanup = await cleanupSource(ports, { ...draft, lifecycle: "abandoned" });
      if (!cleanup.ok) return cleanup;
      return success(null);
    },

    async retryCleanup(templateId: string): Promise<TemplateActionResult<null>> {
      const access = await owner();
      if (!access.ok) return access;
      let draft: TemplateDraftRecord | null;
      try {
        draft = await ports.repository.getTemplate(access.data.orgId, templateId);
      } catch {
        return failure("TEMPLATE_READ_FAILED", "The template could not be loaded.");
      }
      if (!draft || draft.orgId !== access.data.orgId || !["abandoned", "finalized"].includes(draft.lifecycle) || !draft.stagingSourceId) {
        return failure("CLEANUP_RETRY_UNAVAILABLE", "The private source cleanup is no longer available to retry.");
      }
      if (draft.lifecycle === "finalized") {
        if (!draft.supersedesTemplateId || !draft.providerTemplateId || !validStoredDraftContract(draft)) {
          return failure("CLEANUP_RETRY_UNAVAILABLE", "The private source cleanup is no longer available to retry.");
        }
        let source: TemplateDraftRecord | null;
        try { source = await ports.repository.getTemplate(access.data.orgId, draft.supersedesTemplateId); }
        catch { return failure("SOURCE_LINEAGE_READ_FAILED", "The published template lineage could not be verified."); }
        if (!source || source.orgId !== access.data.orgId || source.lifecycle !== "deleted" || !source.providerTemplateId || source.providerTemplateId === draft.providerTemplateId) {
          return failure("SOURCE_LINEAGE_MISMATCH", "The published template lineage could not be safely reconciled.");
        }
      }
      return cleanupSource(ports, draft);
    },

    async duplicate(templateId: string, newName: string): Promise<TemplateActionResult<{ templateId: string; readiness: "ready" | "pending" }>> {
      const access = await owner();
      if (!access.ok) return access;
      const title = safeTitle(newName);
      if (!title.ok) return title;
      let source: TemplateDraftRecord | null;
      try {
        source = await ports.repository.getTemplate(access.data.orgId, templateId);
      } catch {
        return failure("TEMPLATE_READ_FAILED", "The template could not be loaded.");
      }
      if (!source || source.orgId !== access.data.orgId || source.lifecycle !== "finalized" || !source.providerTemplateId || !source.providerAccountId) {
        return failure("TEMPLATE_NOT_FOUND", "Only a finalized template can be duplicated.");
      }
      let draft: TemplateDraftRecord;
      try {
        draft = await ports.repository.createHiddenDuplicate({ orgId: access.data.orgId, sourceTemplateId: source.id, name: title.data });
      } catch {
        return failure("DUPLICATE_LOCAL_FAILED", "The hidden copy could not be prepared.");
      }
      let duplicate: { providerTemplateId: string; readiness: "ready" | "pending" };
      try {
        duplicate = await ports.provider.duplicateTemplate({ providerTemplateId: source.providerTemplateId, expectedProviderAccountId: source.providerAccountId, title: title.data });
      } catch {
        try {
          if (!(await ports.repository.markAbandoned(access.data.orgId, draft.id))) {
            return failure("DUPLICATE_COMPENSATION_FAILED", "The failed provider copy could not be safely reconciled.");
          }
        } catch {
          return failure("DUPLICATE_COMPENSATION_FAILED", "The failed provider copy could not be safely reconciled.");
        }
        return failure("DUPLICATE_PROVIDER_FAILED", "Dropbox Sign could not duplicate the template.");
      }
      try {
        if (!(await ports.repository.attachProviderId(access.data.orgId, draft.id, duplicate.providerTemplateId))) {
          throw new Error("provider copy was not attached");
        }
      } catch {
        try {
          await ports.provider.deleteTemplate(duplicate.providerTemplateId);
          if (!(await ports.repository.markAbandoned(access.data.orgId, draft.id))) {
            return failure("DUPLICATE_COMPENSATION_FAILED", "Sandra could not safely reconcile the provider copy.");
          }
          return failure("DUPLICATE_ATTACH_FAILED", "The provider copy was removed because Sandra could not record it.");
        } catch {
          return failure("DUPLICATE_COMPENSATION_FAILED", "Sandra could not record or safely remove the provider copy.");
        }
      }
      return success({ templateId: draft.id, readiness: duplicate.readiness });
    },

    async delete(templateId: string, confirmRecentSends = false): Promise<TemplateActionResult<null | { recentSendCount: number }>> {
      const access = await owner();
      if (!access.ok) return access;
      let template: TemplateDraftRecord | null;
      try {
        template = await ports.repository.getTemplate(access.data.orgId, templateId);
      } catch {
        return failure("TEMPLATE_READ_FAILED", "The template could not be loaded.");
      }
      if (!template || template.orgId !== access.data.orgId || !["finalized", "deleted"].includes(template.lifecycle) || !template.providerTemplateId) {
        return failure("TEMPLATE_NOT_FOUND", "The finalized template is unavailable.");
      }
      let deletion: { outcome: "deleted" | "already_deleted" | "needs_confirmation"; recentSendCount: number };
      try {
        deletion = await ports.repository.softDelete(access.data.orgId, templateId, confirmRecentSends);
      } catch {
        return failure("RECENT_SEND_CHECK_FAILED", "Recent template usage could not be verified.");
      }
      if (deletion.outcome === "needs_confirmation") {
        return failure("TEMPLATE_RECENTLY_USED", `Confirm deletion of a template used ${deletion.recentSendCount} time${deletion.recentSendCount === 1 ? "" : "s"} in the last 30 days.`);
      }
      try {
        await ports.provider.deleteTemplate(template.providerTemplateId);
      } catch (error) {
        if (!ports.provider.isNotFound(error)) return failure("DELETE_PROVIDER_RECONCILIATION_FAILED", "Sandra retained the deletion record, but Dropbox Sign still needs deletion reconciliation.");
      }
      return success(null);
    },
  };
}

function success<T>(data: T): TemplateActionResult<T> {
  return { ok: true, data };
}

function failure(code: string, message: string): TemplateActionResult<never> {
  return { ok: false, error: { code, message } };
}

function safeTitle(value: string): TemplateActionResult<string> {
  try {
    return success(requireTemplateTitle(value));
  } catch {
    return failure("INVALID_TEMPLATE_TITLE", "Template names must be non-empty and 160 characters or fewer.");
  }
}

function validateServerContract(input: {
  name: string;
  documentType: string;
  signerRoles: readonly TemplateSignerRole[];
  sellerRoleName: string;
  mergeFieldNames: readonly string[];
}): TemplateActionResult<{ name: string; signerRoles: readonly TemplateSignerRole[] }> {
  const title = safeTitle(input.name);
  if (!title.ok) return title;
  if (!input.documentType.trim()) return failure("INVALID_DOCUMENT_TYPE", "Choose a document type.");
  const roles = [...input.signerRoles];
  if (!validRoles(roles)) return failure("INVALID_SIGNER_ROLES", "Signer roles must be exact, unique, and continuously ordered.");
  if (!roles.some((role) => role.name === input.sellerRoleName)) {
    return failure("INVALID_SELLER_ROLE", "Choose the exact seller role from the signer roles.");
  }
  if (!exactMergeFields(input.mergeFieldNames)) return failure("INVALID_MERGE_FIELDS", "Use exactly Sandra's five merge field labels.");
  return success({ name: title.data, signerRoles: roles });
}

function reconcileOption(draft: TemplateDraftRecord, provider: ProviderTemplateState): TemplateActionResult<TemplateOption> {
  if (provider.providerTemplateId !== draft.providerTemplateId) return failure("PROVIDER_ID_MISMATCH", "Dropbox Sign returned a different template identifier.");
  const roles = [...provider.signerRoles];
  if (!validRoles(roles) || JSON.stringify(roles) !== JSON.stringify(draft.signerRoles)) {
    return failure("SIGNER_ROLE_MISMATCH", "Dropbox Sign signer roles do not match the saved ordered roles.");
  }
  if (!roles.some((role) => role.name === draft.sellerRoleName)) return failure("SELLER_ROLE_MISMATCH", "The exact seller role is missing from Dropbox Sign.");
  if (!exactMergeFields(provider.mergeFieldNames) || !exactMergeFields(draft.mergeFieldNames)) {
    return failure("MERGE_FIELD_MISMATCH", "Dropbox Sign must contain exactly Sandra's five merge field labels.");
  }
  const title = safeTitle(draft.name);
  if (!title.ok) return title;
  return success({
    id: draft.id,
    name: title.data,
    documentType: draft.documentType,
    providerTemplateId: provider.providerTemplateId,
    sellerRoleName: draft.sellerRoleName,
    signerRoles: roles,
    mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS,
  });
}

function validRoles(roles: readonly TemplateSignerRole[]): boolean {
  return roles.length > 0 && roles.every((role, index) => role.order === index && Boolean(role.name.trim())) && new Set(roles.map((role) => role.name)).size === roles.length;
}

function exactMergeFields(fields: readonly string[]): boolean {
  return fields.length === ESIGN_TEMPLATE_MERGE_FIELDS.length && ESIGN_TEMPLATE_MERGE_FIELDS.every((field) => fields.includes(field));
}

function validateOnePdf(files: readonly TemplateUpload[]): TemplateActionResult<TemplateUpload> {
  if (files.length !== 1) return failure("PDF_COUNT_INVALID", "Choose exactly one PDF.");
  const file = files[0];
  if (file.mimeType !== "application/pdf") return failure("PDF_TYPE_INVALID", "Choose a PDF file.");
  if (file.size <= 0 || file.size > ESIGN_TEMPLATE_MAX_PDF_BYTES || file.bytes.byteLength !== file.size) {
    return failure("PDF_SIZE_INVALID", "The PDF must be non-empty and no larger than 40 MiB.");
  }
  const magic = String.fromCharCode(...file.bytes.slice(0, 5));
  if (magic !== "%PDF-") return failure("PDF_MAGIC_INVALID", "The uploaded file is not a valid PDF.");
  return success(file);
}

function stagingPath(orgId: string, opaqueId: string): string {
  return `${orgId}/${opaqueId}.pdf`;
}

function isSafeSourceFilename(filename: string): boolean {
  return filename === filename.trim()
    && filename.length >= 1
    && filename.length <= 255
    && filename.toLowerCase().endsWith(".pdf")
    && !/[\\/\u0000-\u001f\u007f]/.test(filename);
}

function isOrgScopedStagingPath(path: string, orgId: string): boolean {
  return new RegExp(`^${escapeRegExp(orgId)}/[0-9a-f-]{36}\\.pdf$`).test(path);
}

function isOpaqueId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function safelyDeleteStagedUpload(ports: TemplateOrchestratorPorts, path: string): Promise<void> {
  try {
    await ports.storage.deletePrivate(path);
  } catch {
    // The action still fails closed. Storage diagnostics are reported server-side by the adapter.
  }
}

async function cleanupUnattachedStage(ports: TemplateOrchestratorPorts, stage: StagedTemplateSource): Promise<boolean> {
  try {
    await ports.storage.deletePrivate(stage.storagePath);
    await ports.repository.recordUnattachedStageCleanup({ orgId: stage.orgId, stageId: stage.id, outcome: "deleted" });
    return true;
  } catch {
    try {
      await ports.repository.recordUnattachedStageCleanup({ orgId: stage.orgId, stageId: stage.id, outcome: "failed" });
    } catch {
      // The caller returns an explicit compensation failure either way.
    }
    return false;
  }
}

async function cleanupSource(ports: TemplateOrchestratorPorts, draft: TemplateDraftRecord): Promise<TemplateActionResult<null>> {
  if (!draft.stagingSourceId) return success(null);
  let stage: StagedTemplateSource | null;
  try {
    stage = await ports.repository.getStage(draft.orgId, draft.stagingSourceId);
  } catch {
    return failure("SOURCE_CLEANUP_READ_FAILED", "The private source cleanup state could not be loaded.");
  }
  if (!stage || stage.orgId !== draft.orgId || !isOrgScopedStagingPath(stage.storagePath, draft.orgId)) return failure("SOURCE_CLEANUP_INVALID", "The private source path could not be safely reconciled.");
  try {
    const deletion = await ports.storage.deletePrivate(stage.storagePath);
    if (deletion !== "deleted" && deletion !== "already_absent") throw new Error("invalid storage deletion outcome");
    await ports.repository.recordSourceCleanup({ orgId: draft.orgId, templateId: draft.id, storagePath: stage.storagePath, outcome: "deleted" });
    return success(null);
  } catch {
    try {
      await ports.repository.recordSourceCleanup({ orgId: draft.orgId, templateId: draft.id, storagePath: stage.storagePath, outcome: "failed" });
    } catch {
      // The safe result below still reports failure; no success is claimed.
    }
    return failure("SOURCE_CLEANUP_FAILED", "The template was processed, but its private source cleanup requires attention.");
  }
}

async function publishRevision(ports: TemplateOrchestratorPorts, orgId: string, revision: TemplateDraftRecord, option: TemplateOption): Promise<boolean> {
  if (!revision.supersedesTemplateId || !revision.providerTemplateId) return false;
  const source = await ports.repository.getTemplate(orgId, revision.supersedesTemplateId);
  const expectedSourceLifecycle = revision.lifecycle === "finalized" ? "deleted" : "finalized";
  if (!source || source.orgId !== orgId || source.lifecycle !== expectedSourceLifecycle || !source.providerTemplateId || source.providerTemplateId === revision.providerTemplateId) return false;
  const outcome = await ports.repository.publishEditRevision({
    orgId,
    sourceTemplateId: source.id,
    revisionTemplateId: revision.id,
    expectedSourceProviderTemplateId: source.providerTemplateId,
    revisionProviderTemplateId: revision.providerTemplateId,
    option,
  });
  return revision.lifecycle === "finalized" ? outcome === "already_published" : outcome === "published";
}

function validStoredDraftContract(draft: TemplateDraftRecord): boolean {
  return validRoles(draft.signerRoles)
    && draft.signerRoles.some((role) => role.name === draft.sellerRoleName)
    && exactMergeFields(draft.mergeFieldNames);
}

async function stageVerifiedSource(ports: TemplateOrchestratorPorts, actor: TemplateActor, file: TemplateUpload): Promise<TemplateActionResult<StagedTemplateSource>> {
  const validated = validateOnePdf([file]);
  if (!validated.ok) return validated;
  const opaqueId = ports.randomId();
  if (!isOpaqueId(opaqueId)) return failure("STAGING_ID_INVALID", "The private upload could not be prepared.");
  const storagePath = stagingPath(actor.orgId, opaqueId);
  try { await ports.storage.putPrivate(storagePath, validated.data.bytes, "application/pdf"); }
  catch { return failure("STAGING_UPLOAD_FAILED", "The PDF could not be stored privately."); }
  let storedBytes: Uint8Array;
  try { storedBytes = await ports.storage.readPrivate(storagePath); }
  catch { await safelyDeleteStagedUpload(ports, storagePath); return failure("STAGING_VERIFY_READ_FAILED", "The private PDF could not be verified after upload."); }
  const stored = validateOnePdf([{ ...validated.data, bytes: storedBytes, size: storedBytes.byteLength }]);
  if (!stored.ok || storedBytes.byteLength !== validated.data.size || await sha256Hex(validated.data.bytes) !== await sha256Hex(storedBytes)) {
    await safelyDeleteStagedUpload(ports, storagePath);
    return failure("STAGING_VERIFY_FAILED", "The stored PDF did not match the uploaded file.");
  }
  const stage: StagedTemplateSource = { id: opaqueId, orgId: actor.orgId, storagePath, filename: validated.data.filename, size: validated.data.size, mimeType: "application/pdf", sha256: await sha256Hex(storedBytes) };
  try { return success(await ports.repository.recordVerifiedStage(stage)); }
  catch { await safelyDeleteStagedUpload(ports, storagePath); return failure("STAGING_RECORD_FAILED", "The private upload could not be recorded."); }
}

async function compensateHiddenDraft(ports: TemplateOrchestratorPorts, draft: TemplateDraftRecord): Promise<boolean> {
  try {
    if (!(await ports.repository.markAbandoned(draft.orgId, draft.id))) return false;
  } catch {
    return false;
  }
  const cleanup = await cleanupSource(ports, { ...draft, lifecycle: "abandoned" });
  return cleanup.ok;
}
