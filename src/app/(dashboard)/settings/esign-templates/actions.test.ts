import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberships: vi.fn(),
  factory: vi.fn(),
  report: vi.fn(),
  initialFactory: vi.fn(),
  prepareUpload: vi.fn(),
  createInitial: vi.fn(),
  cleanupInitial: vi.fn(),
  reconcileInitial: vi.fn(),
  promoteInitial: vi.fn(),
  revalidate: vi.fn(),
  verifyStagedSource: vi.fn(),
  add: vi.fn(),
  duplicate: vi.fn(),
  beginEditRevision: vi.fn(),
  checkEditorReadiness: vi.fn(),
  abandon: vi.fn(),
  retryCleanup: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.report }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships: mocks.memberships }));
vi.mock("@/lib/esign/template-foundation-adapter", () => ({
  createFoundationTemplateOrchestrator: mocks.factory,
}));
vi.mock("@/lib/esign/template-initial-runtime", () => ({ createInitialTemplateRuntime: mocks.initialFactory }));

import { ESIGN_MERGE_FIELD_NAMES } from "@/lib/esign/contracts";
import {
  createTemplateDraftAction,
  deleteTemplateAction,
  duplicateTemplateAction,
  beginTemplateEditRevisionAction,
  checkTemplateEditorReadinessAction,
  abandonTemplateDraftAction,
  retryTemplateSourceCleanupAction,
  prepareTemplateUploadAction,
  reconcileUnknownTemplateProviderAction,
  promoteStaleInitialTemplateProviderCreateAction,
} from "./actions";

describe("template server action boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberships.mockResolvedValue([{ user_id: "owner-1", org_id: "org-1", role: "owner" }]);
    mocks.prepareUpload.mockResolvedValue({ ok: true, data: { stagingSourceId: "source-1", bucket: "esign-staging", storagePath: "org-1/source-1.pdf" } });
    mocks.createInitial.mockResolvedValue({ ok: true, data: { templateId: "template-1" } });
    mocks.cleanupInitial.mockResolvedValue({ ok: true, data: null });
    mocks.reconcileInitial.mockResolvedValue({ ok: true, data: { templateId: "template-1" } });
    mocks.promoteInitial.mockResolvedValue({ ok: true, data: { templateId: "template-1", providerCreateState: "unknown" } });
    mocks.initialFactory.mockResolvedValue({
      prepare: mocks.prepareUpload,
      create: mocks.createInitial,
      cleanupSource: mocks.cleanupInitial,
      reconcileUnknown: mocks.reconcileInitial,
      promoteStaleProviderCreate: mocks.promoteInitial,
    });
    mocks.verifyStagedSource.mockResolvedValue({ ok: true, data: { stagingSourceId: "source-1" } });
    mocks.add.mockResolvedValue({ ok: true, data: { templateId: "template-1" } });
    mocks.duplicate.mockResolvedValue({ ok: true, data: { templateId: "copy-1", readiness: "pending" } });
    mocks.beginEditRevision.mockResolvedValue({ ok: true, data: { templateId: "revision-1", readiness: "pending" } });
    mocks.delete.mockResolvedValue({ ok: true, data: null });
    mocks.checkEditorReadiness.mockResolvedValue({ ok: true, data: { readiness: "pending" } });
    mocks.abandon.mockResolvedValue({ ok: true, data: null });
    mocks.retryCleanup.mockResolvedValue({ ok: true, data: null });
    mocks.factory.mockResolvedValue({
      verifyStagedSource: mocks.verifyStagedSource,
      add: mocks.add,
      duplicate: mocks.duplicate,
      beginEditRevision: mocks.beginEditRevision,
      checkEditorReadiness: mocks.checkEditorReadiness,
      abandon: mocks.abandon,
      retryCleanup: mocks.retryCleanup,
      delete: mocks.delete,
    });
  });

  it("owner-gates before credentials, storage, repository, or provider setup", async () => {
    mocks.memberships.mockResolvedValue([{ user_id: "member-1", org_id: "org-1", role: "member" }]);
    await expect(deleteTemplateAction("template-1")).resolves.toEqual({
      ok: false,
      error: { code: "OWNER_REQUIRED", message: "Only an organization owner can manage eSign templates." },
    });
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it("prepares an opaque owner/org-scoped private path without constructing the provider", async () => {
    const metadata = {
      stagingSourceId: "123e4567-e89b-42d3-a456-426614174000",
      filename: "offer.pdf",
      size: 14,
      mimeType: "application/pdf" as const,
      sha256: "a".repeat(64),
    };
    const result = await prepareTemplateUploadAction(metadata);
    expect(result).toMatchObject({
      ok: true,
      data: {
        bucket: "esign-staging",
        storagePath: "org-1/source-1.pdf",
        stagingSourceId: "source-1",
      },
    });
    expect(mocks.prepareUpload).toHaveBeenCalledWith(metadata);
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it("passes only the small staged reference through the Server Action", async () => {
    const result = await createTemplateDraftAction({
      name: "Offer",
      documentType: "Purchase agreement",
      source: {
        stagingSourceId: "123e4567-e89b-42d3-a456-426614174000",
        bucket: "esign-staging",
        storagePath: "org-1/123e4567-e89b-42d3-a456-426614174000.pdf",
        filename: "offer.pdf",
        size: 14,
        mimeType: "application/pdf",
        sha256: "a".repeat(64),
        origin: "upload",
      },
      signerRoles: [{ name: "Seller", order: 0 }],
      sellerRoleName: "Seller",
      mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
    });
    expect(result).toEqual({ ok: true, data: { templateId: "template-1" } });
    expect(mocks.createInitial).toHaveBeenCalledWith(expect.objectContaining({ source: expect.objectContaining({
      filename: "offer.pdf",
      mimeType: "application/pdf",
      size: 14,
    }) }));
    const actionPayload = mocks.createInitial.mock.calls[0]?.[0];
    expect(actionPayload).not.toHaveProperty("file");
    expect(actionPayload).not.toHaveProperty("bytes");
    expect(JSON.stringify(actionPayload).length).toBeLessThan(1_024);
  });

  it("keeps unexpected database/provider diagnostics out of the returned Result", async () => {
    mocks.factory.mockRejectedValue(new Error("secret SQL detail api_key=private"));
    const result = await duplicateTemplateAction("template-1", "Copy");
    expect(result).toEqual({
      ok: false,
      error: { code: "ESIGN_TEMPLATE_ACTION_FAILED", message: "The eSign template action could not be completed." },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(mocks.report).toHaveBeenCalled();
  });

  it("routes claimed recovery and manual reconciliation through typed server actions", async () => {
    await expect(reconcileUnknownTemplateProviderAction("template-1", "provider-1")).resolves.toEqual({
      ok: true,
      data: { templateId: "template-1" },
    });
    await expect(promoteStaleInitialTemplateProviderCreateAction("template-1")).resolves.toEqual({
      ok: true,
      data: { templateId: "template-1", providerCreateState: "unknown" },
    });
    expect(mocks.reconcileInitial).toHaveBeenCalledWith("template-1", "provider-1");
    expect(mocks.promoteInitial).toHaveBeenCalledWith("template-1");
  });

  it("passes the explicit recent-send confirmation into the atomic delete RPC path", async () => {
    await deleteTemplateAction("template-1", true);
    expect(mocks.delete).toHaveBeenCalledWith("template-1", true);
    expect(mocks.revalidate).toHaveBeenCalledWith("/settings/esign-templates");
  });

  it("preserves duplicate and readiness states through the safe action boundary", async () => {
    await expect(duplicateTemplateAction("template-1", "Copy")).resolves.toEqual({
      ok: true,
      data: { templateId: "copy-1", readiness: "pending" },
    });
    await expect(checkTemplateEditorReadinessAction("copy-1")).resolves.toEqual({
      ok: true,
      data: { readiness: "pending" },
    });
  });

  it("preserves hidden edit-revision readiness and revalidates recovery", async () => {
    await expect(beginTemplateEditRevisionAction("template-1")).resolves.toEqual({
      ok: true,
      data: { templateId: "revision-1", readiness: "pending" },
    });
    expect(mocks.beginEditRevision).toHaveBeenCalledWith("template-1");
    expect(mocks.revalidate).toHaveBeenCalledWith("/settings/esign-templates");
  });

  it("revalidates the server-backed recovery list after a successful cancel", async () => {
    await expect(abandonTemplateDraftAction("copy-1")).resolves.toEqual({ ok: true, data: null });
    expect(mocks.abandon).toHaveBeenCalledWith("copy-1");
    expect(mocks.revalidate).toHaveBeenCalledWith("/settings/esign-templates");
  });

  it("revalidates the recovery list after cleanup convergence", async () => {
    await expect(retryTemplateSourceCleanupAction("copy-1")).resolves.toEqual({ ok: true, data: null });
    expect(mocks.retryCleanup).toHaveBeenCalledWith("copy-1");
    expect(mocks.revalidate).toHaveBeenCalledWith("/settings/esign-templates");
  });
});
