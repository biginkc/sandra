import { beforeEach, describe, expect, it, vi } from "vitest";

import { ESIGN_TEMPLATE_MERGE_FIELDS } from "./template-contract";
import {
  createTemplateOrchestrator,
  ESIGN_TEMPLATE_MAX_PDF_BYTES,
  type StagedTemplateSource,
  type TemplateDraftRecord,
  type TemplateOrchestratorPorts,
  type TemplateUpload,
} from "./template-orchestrator";

const owner = { userId: "user-1", orgId: "org-1", isOwner: true } as const;
const roles = [{ name: "Seller", order: 0 }, { name: "Buyer", order: 1 }] as const;
const pdfBytes = new TextEncoder().encode("%PDF-1.7\nbody");
const sourceId = "123e4567-e89b-42d3-a456-426614174000";
const pdf: TemplateUpload = { filename: "offer.pdf", mimeType: "application/pdf", size: pdfBytes.byteLength, bytes: pdfBytes };
const stage: StagedTemplateSource = {
  id: sourceId,
  orgId: "org-1",
  storagePath: `org-1/${sourceId}.pdf`,
  filename: "offer.pdf",
  size: pdf.size,
  mimeType: "application/pdf",
  sha256: "8c493a43d8a2f643929a28eed63f152c4e68b505506969d28ed62f6c907b06f5",
};
const draft: TemplateDraftRecord = {
  id: "template-1",
  orgId: "org-1",
  name: "Offer",
  documentType: "Purchase agreement",
  providerTemplateId: "provider-1",
  sellerRoleName: "Seller",
  signerRoles: roles,
  mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS,
  stagingSourceId: sourceId,
  supersedesTemplateId: null,
  lifecycle: "editing",
};
const finalized = { ...draft, lifecycle: "finalized" as const, stagingSourceId: null };

function makePorts(): TemplateOrchestratorPorts {
  return {
    auth: { getActor: vi.fn().mockResolvedValue(owner) },
    repository: {
      listFinalized: vi.fn().mockResolvedValue([]),
      listPendingCopies: vi.fn().mockResolvedValue([]),
      recordVerifiedStage: vi.fn().mockImplementation(async (input) => input),
      recordUnattachedStageCleanup: vi.fn().mockResolvedValue(undefined),
      getStage: vi.fn().mockResolvedValue(stage),
      createHiddenDraft: vi.fn().mockResolvedValue({ ...draft, providerTemplateId: null }),
      createHiddenDuplicate: vi.fn().mockResolvedValue({ ...draft, providerTemplateId: null, lifecycle: "preparing" }),
      createHiddenEditRevision: vi.fn().mockResolvedValue({ ...draft, id: "revision-1", providerTemplateId: null, lifecycle: "preparing", supersedesTemplateId: "template-1" }),
      getTemplate: vi.fn().mockResolvedValue(draft),
      attachProviderId: vi.fn().mockResolvedValue(true),
      finalizeDraft: vi.fn().mockResolvedValue(true),
      publishEditRevision: vi.fn().mockResolvedValue("published"),
      markAbandoned: vi.fn().mockResolvedValue(true),
      softDelete: vi.fn().mockResolvedValue({ outcome: "deleted", recentSendCount: 0 }),
      recordSourceCleanup: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      putPrivate: vi.fn().mockResolvedValue(undefined),
      readPrivate: vi.fn().mockResolvedValue(pdfBytes),
      deletePrivate: vi.fn().mockResolvedValue("deleted"),
    },
    provider: {
      embeddedClientId: "client-public-1",
      createDraft: vi.fn().mockResolvedValue({ providerTemplateId: "provider-1" }),
      getFreshEditUrl: vi.fn().mockResolvedValue({ editUrl: "https://app.hellosign.com/editor/transient", expiresAt: 123 }),
      getTemplate: vi.fn().mockResolvedValue({ providerTemplateId: "provider-1", signerRoles: roles, mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS }),
      getTemplateFiles: vi.fn().mockResolvedValue(pdfBytes),
      duplicateTemplate: vi.fn().mockResolvedValue({ providerTemplateId: "provider-copy", readiness: "pending" }),
      deleteTemplate: vi.fn().mockResolvedValue(undefined),
      isNotFound: vi.fn().mockReturnValue(false),
    },
    randomId: vi.fn().mockReturnValue(sourceId),
    now: vi.fn().mockReturnValue(new Date("2026-08-29T12:00:00Z")),
  };
}

function addInput() {
  return {
    stagingSourceId: sourceId,
    name: "  Offer  ",
    documentType: "Purchase agreement",
    signerRoles: roles,
    sellerRoleName: "Seller",
    mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS,
  } as const;
}

describe("template action orchestration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("owner-gates every operation before touching another port", async () => {
    const ports = makePorts();
    vi.mocked(ports.auth.getActor).mockResolvedValue({ ...owner, isOwner: false });
    const core = createTemplateOrchestrator(ports);
    const results = await Promise.all([
      core.list(), core.listPendingCopies(), core.stageSource([pdf]), core.add(addInput()), core.startEditor("template-1"),
      core.beginEditRevision("template-1"), core.finishSync("template-1"), core.abandon("template-1"), core.retryCleanup("template-1"), core.duplicate("template-1", "Copy"), core.delete("template-1"),
    ]);
    expect(results.every((result) => !result.ok && result.error.code === "OWNER_REQUIRED")).toBe(true);
    expect(ports.repository.getTemplate).not.toHaveBeenCalled();
    expect(ports.provider.getTemplate).not.toHaveBeenCalled();
  });

  it("returns a safe Result when authentication or scoped repository reads fail", async () => {
    const authPorts = makePorts();
    vi.mocked(authPorts.auth.getActor).mockRejectedValue(new Error("secret auth detail"));
    await expect(createTemplateOrchestrator(authPorts).list()).resolves.toEqual({
      ok: false,
      error: { code: "AUTH_CHECK_FAILED", message: "Template access could not be verified." },
    });

    const repositoryPorts = makePorts();
    vi.mocked(repositoryPorts.repository.getTemplate).mockRejectedValue(new Error("secret row detail"));
    const result = await createTemplateOrchestrator(repositoryPorts).startEditor("template-1");
    expect(result).toEqual({ ok: false, error: { code: "TEMPLATE_READ_FAILED", message: "The template could not be loaded." } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("lists only through the finalized-only repository query", async () => {
    const ports = makePorts();
    await createTemplateOrchestrator(ports).list();
    expect(ports.repository.listFinalized).toHaveBeenCalledWith("org-1");
  });

  it("discovers pending copies separately without exposing them as finalized send options", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.listPendingCopies).mockResolvedValue([{ id: "pending-1", orgId: "org-1", name: "Offer copy", lifecycle: "editing" }]);
    const core = createTemplateOrchestrator(ports);
    await expect(core.listPendingCopies()).resolves.toEqual({ ok: true, data: [{ id: "pending-1", orgId: "org-1", name: "Offer copy", lifecycle: "editing" }] });
    await expect(core.list()).resolves.toEqual({ ok: true, data: [] });
    expect(ports.repository.listFinalized).toHaveBeenCalledWith("org-1");
    expect(ports.repository.listPendingCopies).toHaveBeenCalledWith("org-1");
  });

  it("fails closed if the pending-copy repository leaks another organization", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.listPendingCopies).mockResolvedValue([{ id: "pending-2", orgId: "org-2", name: "Other org copy", lifecycle: "editing" }]);
    const result = await createTemplateOrchestrator(ports).listPendingCopies();
    expect(result).toMatchObject({ ok: false, error: { code: "PENDING_COPY_SCOPE_MISMATCH" } });
  });

  it("accepts exactly one <=40 MiB PDF with matching MIME, bytes, and magic", async () => {
    const ports = makePorts();
    const core = createTemplateOrchestrator(ports);
    await expect(core.stageSource([])).resolves.toMatchObject({ ok: false, error: { code: "PDF_COUNT_INVALID" } });
    await expect(core.stageSource([pdf, pdf])).resolves.toMatchObject({ ok: false, error: { code: "PDF_COUNT_INVALID" } });
    await expect(core.stageSource([{ ...pdf, mimeType: "text/plain" }])).resolves.toMatchObject({ ok: false, error: { code: "PDF_TYPE_INVALID" } });
    await expect(core.stageSource([{ ...pdf, bytes: new TextEncoder().encode("not-pdf"), size: 7 }])).resolves.toMatchObject({ ok: false, error: { code: "PDF_MAGIC_INVALID" } });
    await expect(core.stageSource([{ ...pdf, size: ESIGN_TEMPLATE_MAX_PDF_BYTES }])).resolves.toMatchObject({ ok: false, error: { code: "PDF_SIZE_INVALID" } });
    await expect(core.stageSource([{ ...pdf, size: ESIGN_TEMPLATE_MAX_PDF_BYTES + 1 }])).resolves.toMatchObject({ ok: false, error: { code: "PDF_SIZE_INVALID" } });
    await expect(core.stageSource([pdf])).resolves.toEqual({ ok: true, data: { stagingSourceId: sourceId } });
    expect(ports.storage.putPrivate).toHaveBeenCalledWith(`org-1/${sourceId}.pdf`, pdf.bytes, "application/pdf");
    expect(ports.storage.readPrivate).toHaveBeenCalledWith(`org-1/${sourceId}.pdf`);
    expect(ports.repository.recordVerifiedStage).toHaveBeenCalledWith(expect.objectContaining({ id: sourceId, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });

  it("fails closed when the privately downloaded object differs from the uploaded PDF", async () => {
    const ports = makePorts();
    vi.mocked(ports.storage.readPrivate).mockResolvedValue(new TextEncoder().encode("%PDF-1.7\ncopy"));
    const result = await createTemplateOrchestrator(ports).stageSource([pdf]);
    expect(result).toMatchObject({ ok: false, error: { code: "STAGING_VERIFY_FAILED" } });
    expect(ports.repository.recordVerifiedStage).not.toHaveBeenCalled();
    expect(ports.storage.deletePrivate).toHaveBeenCalledWith(`org-1/${sourceId}.pdf`);
  });

  it("rejects a forged or cross-org staging path without reading it", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.getStage).mockResolvedValue({ ...stage, orgId: "org-2", storagePath: `org-2/${sourceId}.pdf` });
    const result = await createTemplateOrchestrator(ports).add(addInput());
    expect(result).toMatchObject({ ok: false, error: { code: "STAGING_SOURCE_INVALID" } });
    expect(ports.storage.readPrivate).not.toHaveBeenCalled();
  });

  it("rejects a cross-org template even if a repository port returns it", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.getTemplate).mockResolvedValue({ ...draft, orgId: "org-2" });
    const result = await createTemplateOrchestrator(ports).startEditor("template-1");
    expect(result).toMatchObject({ ok: false, error: { code: "TEMPLATE_NOT_FOUND" } });
    expect(ports.provider.getFreshEditUrl).not.toHaveBeenCalled();
  });

  it("creates a hidden draft, stores only the stable provider ID, and never returns the create URL", async () => {
    const ports = makePorts();
    const result = await createTemplateOrchestrator(ports).add(addInput());
    expect(result).toEqual({ ok: true, data: { templateId: "template-1" } });
    expect(ports.repository.createHiddenDraft).toHaveBeenCalledWith(expect.objectContaining({ name: "Offer" }));
    expect(vi.mocked(ports.repository.createHiddenDraft).mock.calls[0][0]).not.toHaveProperty("lifecycle");
    expect(ports.repository.attachProviderId).toHaveBeenCalledWith("org-1", "template-1", "provider-1");
    expect(JSON.stringify(result)).not.toContain("http");
  });

  it("preserves exact case-distinct signer roles through local and provider DTOs", async () => {
    const ports = makePorts();
    const caseDistinctRoles = [{ name: "Seller", order: 0 }, { name: "seller", order: 1 }] as const;
    const result = await createTemplateOrchestrator(ports).add({ ...addInput(), signerRoles: caseDistinctRoles });
    expect(result).toEqual({ ok: true, data: { templateId: "template-1" } });
    expect(ports.repository.createHiddenDraft).toHaveBeenCalledWith(expect.objectContaining({ signerRoles: caseDistinctRoles, sellerRoleName: "Seller" }));
    expect(ports.provider.createDraft).toHaveBeenCalledWith(expect.objectContaining({ signerRoles: caseDistinctRoles }));
  });

  it("cleans and audits an unattached verified source when hidden draft creation fails", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.createHiddenDraft).mockRejectedValue(new Error("database private detail"));
    const result = await createTemplateOrchestrator(ports).add(addInput());
    expect(result).toEqual({ ok: false, error: { code: "DRAFT_CREATE_FAILED", message: "The hidden template draft could not be created." } });
    expect(ports.storage.deletePrivate).toHaveBeenCalledWith(stage.storagePath);
    expect(ports.repository.recordUnattachedStageCleanup).toHaveBeenCalledWith({ orgId: "org-1", stageId: sourceId, outcome: "deleted" });
  });

  it("removes the provider draft when its stable ID cannot be attached locally", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.attachProviderId).mockResolvedValue(false);
    const result = await createTemplateOrchestrator(ports).add(addInput());
    expect(result).toMatchObject({ ok: false, error: { code: "LOCAL_ATTACH_FAILED" } });
    expect(ports.provider.deleteTemplate).toHaveBeenCalledWith("provider-1");
    expect(ports.repository.markAbandoned).toHaveBeenCalledWith("org-1", "template-1");
  });

  it("cleans and audits the staged source when provider creation fails", async () => {
    const ports = makePorts();
    vi.mocked(ports.provider.createDraft).mockRejectedValue(new Error("provider secret"));
    const result = await createTemplateOrchestrator(ports).add(addInput());
    expect(result).toEqual({ ok: false, error: { code: "PROVIDER_CREATE_FAILED", message: "Dropbox Sign could not create the template draft." } });
    expect(ports.storage.deletePrivate).toHaveBeenCalledWith(stage.storagePath);
    expect(ports.repository.recordSourceCleanup).toHaveBeenCalledWith(expect.objectContaining({ outcome: "deleted" }));
    expect(ports.repository.markAbandoned).toHaveBeenCalledWith("org-1", "template-1");
  });

  it("returns a fresh transient edit URL without persisting it", async () => {
    const ports = makePorts();
    const result = await createTemplateOrchestrator(ports).startEditor("template-1");
    expect(result).toEqual({ ok: true, data: { providerTemplateId: "provider-1", editUrl: "https://app.hellosign.com/editor/transient", expiresAt: 123, clientId: "client-public-1" } });
    expect(ports.repository.attachProviderId).not.toHaveBeenCalled();
  });

  it("never requests an edit URL for a finalized active provider template", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.getTemplate).mockResolvedValue(finalized);
    const result = await createTemplateOrchestrator(ports).startEditor("template-1");
    expect(result).toMatchObject({ ok: false, error: { code: "TEMPLATE_NOT_FOUND" } });
    expect(ports.provider.getTemplate).not.toHaveBeenCalled();
    expect(ports.provider.getFreshEditUrl).not.toHaveBeenCalled();
  });

  it("creates a hidden provider-distinct edit revision without mutating the active template", async () => {
    const ports = makePorts();
    const revision = { ...draft, id: "revision-1", lifecycle: "preparing" as const, providerTemplateId: null, supersedesTemplateId: finalized.id };
    vi.mocked(ports.repository.getTemplate).mockResolvedValueOnce(finalized);
    vi.mocked(ports.repository.createHiddenEditRevision).mockResolvedValue(revision);
    vi.mocked(ports.provider.duplicateTemplate).mockResolvedValue({ providerTemplateId: "provider-revision", readiness: "pending" });

    await expect(createTemplateOrchestrator(ports).beginEditRevision(finalized.id)).resolves.toEqual({
      ok: true,
      data: { templateId: revision.id, readiness: "pending" },
    });

    expect(ports.provider.getTemplateFiles).toHaveBeenCalledWith(finalized.providerTemplateId);
    expect(ports.repository.createHiddenEditRevision).toHaveBeenCalledWith({ orgId: owner.orgId, sourceTemplateId: finalized.id, stagingSourceId: sourceId });
    expect(ports.provider.duplicateTemplate).toHaveBeenCalledWith({ providerTemplateId: finalized.providerTemplateId, title: finalized.name });
    expect(ports.repository.attachProviderId).toHaveBeenCalledWith(owner.orgId, revision.id, "provider-revision");
    expect(ports.repository.finalizeDraft).not.toHaveBeenCalled();
    expect(ports.repository.publishEditRevision).not.toHaveBeenCalled();
    expect(ports.repository.softDelete).not.toHaveBeenCalled();
  });

  it("publishes a reconciled hidden edit revision atomically and only then cleans its source", async () => {
    const ports = makePorts();
    const revision = { ...draft, id: "revision-1", providerTemplateId: "provider-revision", supersedesTemplateId: finalized.id };
    vi.mocked(ports.repository.getTemplate).mockResolvedValueOnce(revision).mockResolvedValueOnce(finalized);
    vi.mocked(ports.provider.getTemplate).mockResolvedValue({ providerTemplateId: "provider-revision", signerRoles: roles, mergeFieldNames: [...ESIGN_TEMPLATE_MERGE_FIELDS].reverse() });

    const result = await createTemplateOrchestrator(ports).finishSync(revision.id);

    expect(result).toMatchObject({ ok: true, data: { id: revision.id, providerTemplateId: "provider-revision" } });
    expect(ports.repository.publishEditRevision).toHaveBeenCalledWith(expect.objectContaining({
      orgId: owner.orgId,
      sourceTemplateId: finalized.id,
      revisionTemplateId: revision.id,
      expectedSourceProviderTemplateId: finalized.providerTemplateId,
      revisionProviderTemplateId: "provider-revision",
    }));
    expect(ports.repository.finalizeDraft).not.toHaveBeenCalled();
    expect(ports.storage.deletePrivate).toHaveBeenCalledWith(stage.storagePath);
    expect(ports.provider.deleteTemplate).not.toHaveBeenCalled();
    expect(ports.repository.softDelete).not.toHaveBeenCalled();
  });

  it("leaves the original active when an edit revision publish fails", async () => {
    const ports = makePorts();
    const revision = { ...draft, id: "revision-1", providerTemplateId: "provider-revision", supersedesTemplateId: finalized.id };
    vi.mocked(ports.repository.getTemplate).mockResolvedValueOnce(revision).mockResolvedValueOnce(finalized);
    vi.mocked(ports.provider.getTemplate).mockResolvedValue({ providerTemplateId: "provider-revision", signerRoles: roles, mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS });
    vi.mocked(ports.repository.publishEditRevision).mockRejectedValue(new Error("publish conflict"));

    await expect(createTemplateOrchestrator(ports).finishSync(revision.id)).resolves.toMatchObject({ ok: false, error: { code: "FINALIZE_LOCAL_FAILED" } });
    expect(ports.storage.deletePrivate).not.toHaveBeenCalled();
    expect(ports.provider.deleteTemplate).not.toHaveBeenCalled();
    expect(ports.repository.markAbandoned).not.toHaveBeenCalled();
    expect(ports.repository.softDelete).not.toHaveBeenCalled();
  });

  it("reconciles an exact already-published successor after the publish response is lost", async () => {
    const ports = makePorts();
    const revision = { ...draft, id: "revision-1", providerTemplateId: "provider-revision", supersedesTemplateId: finalized.id };
    const publishedRevision = { ...revision, lifecycle: "finalized" as const };
    const retiredSource = { ...finalized, lifecycle: "deleted" as const };
    vi.mocked(ports.repository.getTemplate)
      .mockResolvedValueOnce(revision)
      .mockResolvedValueOnce(finalized)
      .mockResolvedValueOnce(publishedRevision)
      .mockResolvedValueOnce(retiredSource);
    vi.mocked(ports.provider.getTemplate).mockResolvedValue({ providerTemplateId: "provider-revision", signerRoles: roles, mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS });
    vi.mocked(ports.repository.publishEditRevision)
      .mockRejectedValueOnce(new Error("response lost after commit"))
      .mockResolvedValueOnce("already_published");
    const core = createTemplateOrchestrator(ports);

    await expect(core.finishSync(revision.id)).resolves.toMatchObject({ ok: false, error: { code: "FINALIZE_LOCAL_FAILED" } });
    await expect(core.finishSync(revision.id)).resolves.toMatchObject({ ok: true, data: { id: revision.id, providerTemplateId: "provider-revision" } });

    expect(ports.repository.publishEditRevision).toHaveBeenCalledTimes(2);
    expect(ports.storage.deletePrivate).toHaveBeenCalledTimes(1);
    expect(ports.provider.deleteTemplate).not.toHaveBeenCalled();
    expect(ports.repository.markAbandoned).not.toHaveBeenCalled();
    expect(ports.repository.finalizeDraft).not.toHaveBeenCalled();
    expect(ports.repository.softDelete).not.toHaveBeenCalled();
  });

  it("rediscovers and cleanup-only reconciles a published successor after its deleted receipt fails", async () => {
    const ports = makePorts();
    const revision = { ...draft, id: "revision-1", providerTemplateId: "provider-revision", supersedesTemplateId: finalized.id };
    const publishedRevision = { ...revision, lifecycle: "finalized" as const };
    const retiredSource = { ...finalized, lifecycle: "deleted" as const };
    vi.mocked(ports.repository.getTemplate)
      .mockResolvedValueOnce(revision)
      .mockResolvedValueOnce(finalized)
      .mockResolvedValueOnce(publishedRevision)
      .mockResolvedValueOnce(retiredSource);
    vi.mocked(ports.provider.getTemplate).mockResolvedValue({ providerTemplateId: "provider-revision", signerRoles: roles, mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS });
    vi.mocked(ports.storage.deletePrivate).mockResolvedValueOnce("deleted").mockResolvedValueOnce("already_absent");
    vi.mocked(ports.repository.recordSourceCleanup).mockRejectedValueOnce(new Error("deleted receipt unavailable")).mockResolvedValue(undefined);
    const core = createTemplateOrchestrator(ports);

    await expect(core.finishSync(revision.id)).resolves.toMatchObject({ ok: false, error: { code: "SOURCE_CLEANUP_FAILED" } });
    vi.mocked(ports.repository.listPendingCopies).mockResolvedValue([{ id: revision.id, orgId: owner.orgId, name: revision.name, lifecycle: "cleanup_attention", kind: "edit_revision" }]);
    await expect(core.listPendingCopies()).resolves.toMatchObject({ ok: true, data: [expect.objectContaining({ id: revision.id, lifecycle: "cleanup_attention" })] });
    await expect(core.retryCleanup(revision.id)).resolves.toEqual({ ok: true, data: null });

    expect(ports.repository.publishEditRevision).toHaveBeenCalledTimes(1);
    expect(ports.provider.getTemplate).toHaveBeenCalledTimes(1);
    expect(ports.storage.deletePrivate).toHaveBeenNthCalledWith(2, stage.storagePath);
    expect(ports.repository.recordSourceCleanup).toHaveBeenLastCalledWith(expect.objectContaining({ templateId: revision.id, outcome: "deleted" }));
    expect(ports.provider.deleteTemplate).not.toHaveBeenCalled();
    expect(ports.repository.markAbandoned).not.toHaveBeenCalled();
    expect(ports.repository.finalizeDraft).not.toHaveBeenCalled();
    expect(ports.repository.softDelete).not.toHaveBeenCalled();
  });

  it("fails closed unless a finalized successor receives explicit already_published reconciliation", async () => {
    const ports = makePorts();
    const publishedRevision = { ...draft, id: "revision-1", lifecycle: "finalized" as const, providerTemplateId: "provider-revision", supersedesTemplateId: finalized.id };
    const retiredSource = { ...finalized, lifecycle: "deleted" as const };
    vi.mocked(ports.repository.getTemplate).mockResolvedValueOnce(publishedRevision).mockResolvedValueOnce(retiredSource);
    vi.mocked(ports.provider.getTemplate).mockResolvedValue({ providerTemplateId: "provider-revision", signerRoles: roles, mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS });
    vi.mocked(ports.repository.publishEditRevision).mockResolvedValue("published");

    await expect(createTemplateOrchestrator(ports).finishSync(publishedRevision.id)).resolves.toMatchObject({ ok: false, error: { code: "DRAFT_STALE" } });
    expect(ports.storage.deletePrivate).not.toHaveBeenCalled();
    expect(ports.provider.deleteTemplate).not.toHaveBeenCalled();
  });

  it("rejects finalized cleanup retry when the retired source provider lineage is not distinct", async () => {
    const ports = makePorts();
    const publishedRevision = { ...draft, id: "revision-1", lifecycle: "finalized" as const, providerTemplateId: "provider-1", supersedesTemplateId: finalized.id };
    const retiredSource = { ...finalized, lifecycle: "deleted" as const };
    vi.mocked(ports.repository.getTemplate).mockResolvedValueOnce(publishedRevision).mockResolvedValueOnce(retiredSource);

    await expect(createTemplateOrchestrator(ports).retryCleanup(publishedRevision.id)).resolves.toMatchObject({ ok: false, error: { code: "SOURCE_LINEAGE_MISMATCH" } });
    expect(ports.storage.deletePrivate).not.toHaveBeenCalled();
    expect(ports.repository.recordSourceCleanup).not.toHaveBeenCalled();
    expect(ports.provider.deleteTemplate).not.toHaveBeenCalled();
    expect(ports.repository.publishEditRevision).not.toHaveBeenCalled();
  });

  it("cancels only the hidden edit revision and leaves the original untouched", async () => {
    const ports = makePorts();
    const revision = { ...draft, id: "revision-1", providerTemplateId: "provider-revision", supersedesTemplateId: finalized.id };
    vi.mocked(ports.repository.getTemplate).mockResolvedValueOnce(revision);

    await expect(createTemplateOrchestrator(ports).abandon(revision.id)).resolves.toEqual({ ok: true, data: null });

    expect(ports.provider.deleteTemplate).toHaveBeenCalledWith("provider-revision");
    expect(ports.repository.markAbandoned).toHaveBeenCalledWith(owner.orgId, revision.id);
    expect(ports.repository.publishEditRevision).not.toHaveBeenCalled();
    expect(ports.repository.finalizeDraft).not.toHaveBeenCalled();
    expect(ports.repository.softDelete).not.toHaveBeenCalled();
  });

  it("abandons and cleans a failed hidden edit revision without mutating the original", async () => {
    const ports = makePorts();
    const revision = { ...draft, id: "revision-1", lifecycle: "preparing" as const, providerTemplateId: null, supersedesTemplateId: finalized.id };
    vi.mocked(ports.repository.getTemplate).mockResolvedValueOnce(finalized);
    vi.mocked(ports.repository.createHiddenEditRevision).mockResolvedValue(revision);
    vi.mocked(ports.provider.duplicateTemplate).mockRejectedValue(new Error("provider copy failed"));

    await expect(createTemplateOrchestrator(ports).beginEditRevision(finalized.id)).resolves.toMatchObject({ ok: false, error: { code: "EDIT_PROVIDER_COPY_FAILED" } });

    expect(ports.repository.markAbandoned).toHaveBeenCalledWith(owner.orgId, revision.id);
    expect(ports.storage.deletePrivate).toHaveBeenCalledWith(stage.storagePath);
    expect(ports.repository.publishEditRevision).not.toHaveBeenCalled();
    expect(ports.repository.finalizeDraft).not.toHaveBeenCalled();
    expect(ports.repository.softDelete).not.toHaveBeenCalled();
  });

  it("checks provider readiness before requesting any edit URL", async () => {
    const ports = makePorts();
    const providerPending = new Error("not ready");
    vi.mocked(ports.provider.getTemplate).mockRejectedValue(providerPending);
    vi.mocked(ports.provider.isNotFound).mockImplementation((error) => error === providerPending);
    const readiness = await createTemplateOrchestrator(ports).checkEditorReadiness("template-1");
    expect(readiness).toEqual({ ok: true, data: { readiness: "pending" } });
    const editor = await createTemplateOrchestrator(ports).startEditor("template-1");
    expect(editor).toMatchObject({ ok: false, error: { code: "EDITOR_SESSION_FAILED" } });
    expect(ports.provider.getFreshEditUrl).not.toHaveBeenCalled();
  });

  it("returns an allowlisted readiness error for non-delay provider failures", async () => {
    const ports = makePorts();
    vi.mocked(ports.provider.getTemplate).mockRejectedValue(new Error("secret provider diagnostic"));
    const result = await createTemplateOrchestrator(ports).checkEditorReadiness("template-1");
    expect(result).toEqual({ ok: false, error: { code: "DUPLICATE_READINESS_FAILED", message: "Dropbox Sign could not check whether the copy is ready." } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each([
    [{ providerTemplateId: "other", signerRoles: roles, mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS }, "PROVIDER_ID_MISMATCH"],
    [{ providerTemplateId: "provider-1", signerRoles: [...roles].reverse(), mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS }, "SIGNER_ROLE_MISMATCH"],
    [{ providerTemplateId: "provider-1", signerRoles: [{ name: "seller", order: 0 }, { name: "Buyer", order: 1 }], mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS }, "SIGNER_ROLE_MISMATCH"],
    [{ providerTemplateId: "provider-1", signerRoles: roles, mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS.slice(0, 4) }, "MERGE_FIELD_MISMATCH"],
  ])("rejects provider/local reconciliation mismatch %#", async (provider, code) => {
    const ports = makePorts();
    vi.mocked(ports.provider.getTemplate).mockResolvedValue(provider);
    const result = await createTemplateOrchestrator(ports).finishSync("template-1");
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(ports.repository.finalizeDraft).not.toHaveBeenCalled();
  });

  it("rejects stale finalization after provider state is refetched", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.finalizeDraft).mockResolvedValue(false);
    const result = await createTemplateOrchestrator(ports).finishSync("template-1");
    expect(ports.provider.getTemplate).toHaveBeenCalledBefore(vi.mocked(ports.repository.finalizeDraft));
    expect(result).toMatchObject({ ok: false, error: { code: "DRAFT_STALE" } });
  });

  it("finalizes exact provider state, then deletes and audits the private source", async () => {
    const ports = makePorts();
    const result = await createTemplateOrchestrator(ports).finishSync("template-1");
    expect(result).toMatchObject({ ok: true, data: { providerTemplateId: "provider-1", sellerRoleName: "Seller", signerRoles: roles, mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS } });
    expect(ports.storage.deletePrivate).toHaveBeenCalledWith(stage.storagePath);
    expect(ports.repository.recordSourceCleanup).toHaveBeenCalledWith({ orgId: "org-1", templateId: "template-1", storagePath: stage.storagePath, outcome: "deleted" });
  });

  it("does not claim abandon success when source cleanup fails and audits the failure", async () => {
    const ports = makePorts();
    vi.mocked(ports.storage.deletePrivate).mockRejectedValue(new Error("private detail"));
    const result = await createTemplateOrchestrator(ports).abandon("template-1");
    expect(result).toEqual({ ok: false, error: { code: "SOURCE_CLEANUP_FAILED", message: "The template was processed, but its private source cleanup requires attention." } });
    expect(JSON.stringify(result)).not.toContain("private detail");
    expect(ports.repository.recordSourceCleanup).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(ports.repository.markAbandoned).toHaveBeenCalledBefore(vi.mocked(ports.storage.deletePrivate));
  });

  it("cancels a pending duplicate through provider delete and local abandon", async () => {
    const ports = makePorts();
    const result = await createTemplateOrchestrator(ports).abandon("template-1");
    expect(result).toEqual({ ok: true, data: null });
    expect(ports.provider.deleteTemplate).toHaveBeenCalledWith("provider-1");
    expect(ports.repository.markAbandoned).toHaveBeenCalledWith("org-1", "template-1");
  });

  it("leaves provider-delete and local-abandon failures retryable", async () => {
    const providerPorts = makePorts();
    vi.mocked(providerPorts.provider.deleteTemplate).mockRejectedValueOnce(new Error("provider unavailable"));
    const core = createTemplateOrchestrator(providerPorts);
    await expect(core.abandon("template-1")).resolves.toMatchObject({ ok: false, error: { code: "ABANDON_PROVIDER_FAILED" } });
    await expect(core.abandon("template-1")).resolves.toEqual({ ok: true, data: null });
    expect(providerPorts.provider.deleteTemplate).toHaveBeenCalledTimes(2);

    const localPorts = makePorts();
    vi.mocked(localPorts.repository.markAbandoned).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(localPorts.provider.isNotFound).mockReturnValue(true);
    const localCore = createTemplateOrchestrator(localPorts);
    await expect(localCore.abandon("template-1")).resolves.toMatchObject({ ok: false, error: { code: "ABANDON_LOCAL_FAILED" } });
    vi.mocked(localPorts.provider.deleteTemplate).mockRejectedValueOnce(new Error("already deleted"));
    await expect(localCore.abandon("template-1")).resolves.toEqual({ ok: true, data: null });
  });

  it("rediscovers and converges failed cleanup without repeating provider delete or abandon", async () => {
    const ports = makePorts();
    const abandoned = { ...draft, lifecycle: "abandoned" as const };
    vi.mocked(ports.repository.getTemplate).mockResolvedValueOnce(draft).mockResolvedValueOnce(abandoned);
    vi.mocked(ports.storage.deletePrivate).mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValueOnce("deleted");
    const core = createTemplateOrchestrator(ports);
    await expect(core.abandon("template-1")).resolves.toMatchObject({ ok: false, error: { code: "SOURCE_CLEANUP_FAILED" } });
    const providerCallsAfterAbandon = vi.mocked(ports.provider.deleteTemplate).mock.calls.length;
    const abandonCallsAfterAbandon = vi.mocked(ports.repository.markAbandoned).mock.calls.length;
    vi.mocked(ports.repository.listPendingCopies).mockResolvedValue([{ id: "template-1", orgId: "org-1", name: "Offer copy", lifecycle: "cleanup_attention" }]);
    await expect(core.listPendingCopies()).resolves.toMatchObject({ ok: true, data: [expect.objectContaining({ id: "template-1", lifecycle: "cleanup_attention" })] });
    await expect(core.retryCleanup("template-1")).resolves.toEqual({ ok: true, data: null });
    expect(ports.provider.deleteTemplate).toHaveBeenCalledTimes(providerCallsAfterAbandon);
    expect(providerCallsAfterAbandon).toBe(1);
    expect(ports.repository.markAbandoned).toHaveBeenCalledTimes(abandonCallsAfterAbandon);
    expect(abandonCallsAfterAbandon).toBe(1);
    expect(ports.storage.deletePrivate).toHaveBeenCalledTimes(2);
    expect(ports.repository.recordSourceCleanup).toHaveBeenNthCalledWith(1, expect.objectContaining({ outcome: "failed" }));
    expect(ports.repository.recordSourceCleanup).toHaveBeenNthCalledWith(2, expect.objectContaining({ outcome: "deleted" }));
    expect(ports.repository.finalizeDraft).not.toHaveBeenCalled();
    expect(ports.repository.softDelete).not.toHaveBeenCalled();
  });

  it("records cleanup after retry finds an object already absent following a failed deleted receipt", async () => {
    const ports = makePorts();
    const abandoned = { ...draft, lifecycle: "abandoned" as const };
    vi.mocked(ports.repository.getTemplate).mockResolvedValueOnce(draft).mockResolvedValueOnce(abandoned);
    vi.mocked(ports.storage.deletePrivate).mockResolvedValueOnce("deleted").mockResolvedValueOnce("already_absent");
    vi.mocked(ports.repository.recordSourceCleanup).mockRejectedValueOnce(new Error("receipt unavailable")).mockResolvedValueOnce(undefined);
    const core = createTemplateOrchestrator(ports);

    await expect(core.abandon("template-1")).resolves.toMatchObject({ ok: false, error: { code: "SOURCE_CLEANUP_FAILED" } });
    const providerCallsAfterAbandon = vi.mocked(ports.provider.deleteTemplate).mock.calls.length;
    const abandonCallsAfterAbandon = vi.mocked(ports.repository.markAbandoned).mock.calls.length;
    vi.mocked(ports.repository.listPendingCopies).mockResolvedValue([{ id: "template-1", orgId: "org-1", name: "Offer copy", lifecycle: "cleanup_attention" }]);
    await expect(core.listPendingCopies()).resolves.toMatchObject({ ok: true, data: [expect.objectContaining({ id: "template-1", lifecycle: "cleanup_attention" })] });
    await expect(core.retryCleanup("template-1")).resolves.toEqual({ ok: true, data: null });

    expect(ports.storage.deletePrivate).toHaveBeenNthCalledWith(1, stage.storagePath);
    expect(ports.storage.deletePrivate).toHaveBeenNthCalledWith(2, stage.storagePath);
    expect(ports.repository.recordSourceCleanup).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "deleted" }));
    expect(ports.provider.deleteTemplate).toHaveBeenCalledTimes(providerCallsAfterAbandon);
    expect(providerCallsAfterAbandon).toBe(1);
    expect(ports.repository.markAbandoned).toHaveBeenCalledTimes(abandonCallsAfterAbandon);
    expect(abandonCallsAfterAbandon).toBe(1);
    expect(ports.repository.finalizeDraft).not.toHaveBeenCalled();
    expect(ports.repository.softDelete).not.toHaveBeenCalled();
    expect(ports.provider.createDraft).not.toHaveBeenCalled();
    expect(ports.provider.duplicateTemplate).not.toHaveBeenCalled();
  });

  it("denies a cross-org cleanup retry without touching storage", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.getTemplate).mockResolvedValue({ ...draft, orgId: "org-2", lifecycle: "abandoned" });
    const result = await createTemplateOrchestrator(ports).retryCleanup("template-1");
    expect(result).toMatchObject({ ok: false, error: { code: "CLEANUP_RETRY_UNAVAILABLE" } });
    expect(ports.storage.deletePrivate).not.toHaveBeenCalled();
  });

  it("keeps duplicate rows hidden for ready and asynchronous provider responses", async () => {
    for (const readiness of ["ready", "pending"] as const) {
      const ports = makePorts();
      vi.mocked(ports.repository.getTemplate).mockResolvedValue(finalized);
      vi.mocked(ports.provider.duplicateTemplate).mockResolvedValue({ providerTemplateId: `copy-${readiness}`, readiness });
      const result = await createTemplateOrchestrator(ports).duplicate("template-1", "  Copy  ");
      expect(result).toEqual({ ok: true, data: { templateId: "template-1", readiness } });
      expect(ports.repository.createHiddenDuplicate).toHaveBeenCalledWith({ orgId: "org-1", sourceTemplateId: "template-1", name: "Copy" });
      expect(ports.repository.finalizeDraft).not.toHaveBeenCalled();
    }
  });

  it("returns a safe quota-style duplicate failure without false success", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.getTemplate).mockResolvedValue(finalized);
    vi.mocked(ports.provider.duplicateTemplate).mockRejectedValue(new Error("quota for secret account@example.com"));
    const result = await createTemplateOrchestrator(ports).duplicate("template-1", "Copy");
    expect(result).toEqual({ ok: false, error: { code: "DUPLICATE_PROVIDER_FAILED", message: "Dropbox Sign could not duplicate the template." } });
    expect(JSON.stringify(result)).not.toContain("account@example.com");
  });

  it("compensates a duplicate whose provider ID cannot be attached", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.getTemplate).mockResolvedValue(finalized);
    vi.mocked(ports.repository.attachProviderId).mockResolvedValue(false);
    const result = await createTemplateOrchestrator(ports).duplicate("template-1", "Copy");
    expect(result).toMatchObject({ ok: false, error: { code: "DUPLICATE_ATTACH_FAILED" } });
    expect(ports.provider.deleteTemplate).toHaveBeenCalledWith("provider-copy");
  });

  it("rechecks 30-day usage at delete time and retains history", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.getTemplate).mockResolvedValue(finalized);
    vi.mocked(ports.repository.softDelete).mockResolvedValue({ outcome: "needs_confirmation", recentSendCount: 1 });
    const blocked = await createTemplateOrchestrator(ports).delete("template-1");
    expect(blocked).toMatchObject({ ok: false, error: { code: "TEMPLATE_RECENTLY_USED" } });
    expect(ports.provider.deleteTemplate).not.toHaveBeenCalled();

    vi.mocked(ports.repository.softDelete).mockResolvedValue({ outcome: "deleted", recentSendCount: 1 });
    const deleted = await createTemplateOrchestrator(ports).delete("template-1", true);
    expect(deleted).toEqual({ ok: true, data: null });
    expect(ports.repository.softDelete).toHaveBeenLastCalledWith("org-1", "template-1", true);
  });

  it("treats provider 404 delete as idempotent after the atomic local delete", async () => {
    const ports = makePorts();
    const notFound = new Error("provider detail");
    vi.mocked(ports.repository.getTemplate).mockResolvedValue(finalized);
    vi.mocked(ports.provider.deleteTemplate).mockRejectedValue(notFound);
    vi.mocked(ports.provider.isNotFound).mockImplementation((error) => error === notFound);
    const result = await createTemplateOrchestrator(ports).delete("template-1");
    expect(result).toEqual({ ok: true, data: null });
    expect(ports.repository.softDelete).toHaveBeenCalled();
  });

  it("reports explicit provider reconciliation after the atomic local delete", async () => {
    const ports = makePorts();
    vi.mocked(ports.repository.getTemplate).mockResolvedValue(finalized);
    vi.mocked(ports.provider.deleteTemplate).mockRejectedValue(new Error("provider private detail"));
    const result = await createTemplateOrchestrator(ports).delete("template-1");
    expect(result).toEqual({
      ok: false,
      error: {
        code: "DELETE_PROVIDER_RECONCILIATION_FAILED",
        message: "Sandra retained the deletion record, but Dropbox Sign still needs deletion reconciliation.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private detail");
  });
});
