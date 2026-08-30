import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberships: vi.fn(),
  factory: vi.fn(),
  report: vi.fn(),
  revalidate: vi.fn(),
  stageSource: vi.fn(),
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

import { ESIGN_MERGE_FIELD_NAMES } from "@/lib/esign/contracts";
import {
  createTemplateDraftAction,
  deleteTemplateAction,
  duplicateTemplateAction,
  beginTemplateEditRevisionAction,
  checkTemplateEditorReadinessAction,
  abandonTemplateDraftAction,
  retryTemplateSourceCleanupAction,
} from "./actions";

describe("template server action boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberships.mockResolvedValue([{ user_id: "owner-1", org_id: "org-1", role: "owner" }]);
    mocks.stageSource.mockResolvedValue({ ok: true, data: { stagingSourceId: "source-1" } });
    mocks.add.mockResolvedValue({ ok: true, data: { templateId: "template-1" } });
    mocks.duplicate.mockResolvedValue({ ok: true, data: { templateId: "copy-1", readiness: "pending" } });
    mocks.beginEditRevision.mockResolvedValue({ ok: true, data: { templateId: "revision-1", readiness: "pending" } });
    mocks.delete.mockResolvedValue({ ok: true, data: null });
    mocks.checkEditorReadiness.mockResolvedValue({ ok: true, data: { readiness: "pending" } });
    mocks.abandon.mockResolvedValue({ ok: true, data: null });
    mocks.retryCleanup.mockResolvedValue({ ok: true, data: null });
    mocks.factory.mockResolvedValue({
      stageSource: mocks.stageSource,
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

  it("passes actual File bytes into private staging before creating the provider draft", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nbody");
    const file = new File([bytes], "offer.pdf", { type: "application/pdf" });
    const result = await createTemplateDraftAction({
      name: "Offer",
      documentType: "Purchase agreement",
      source: { file, origin: "upload" },
      signerRoles: [{ name: "Seller", order: 0 }],
      sellerRoleName: "Seller",
      mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
    });
    expect(result).toEqual({ ok: true, data: { templateId: "template-1" } });
    expect(mocks.stageSource).toHaveBeenCalledWith([expect.objectContaining({
      filename: "offer.pdf",
      mimeType: "application/pdf",
      size: bytes.byteLength,
      bytes: expect.any(Uint8Array),
    })]);
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ stagingSourceId: "source-1" }));
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
