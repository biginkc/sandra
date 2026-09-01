import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  create: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@/lib/errors/call-action", () => ({
  callAction: async (promise: Promise<unknown>) => promise,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, file: File, options: unknown) =>
          mocks.upload(bucket, path, file, options),
      }),
    },
  }),
}));
vi.mock("./actions", () => ({
  prepareTemplateUploadAction: mocks.prepare,
  createTemplateDraftAction: mocks.create,
  abandonTemplateDraftAction: vi.fn(),
  beginTemplateEditRevisionAction: vi.fn(),
  checkTemplateEditorReadinessAction: vi.fn(),
  deleteTemplateAction: vi.fn(),
  duplicateTemplateAction: vi.fn(),
  retryTemplateSourceCleanupAction: vi.fn(),
  retryUnattachedTemplateSourceCleanupAction: vi.fn(),
  reconcileUnknownTemplateProviderAction: vi.fn(),
  promoteStaleInitialTemplateProviderCreateAction: vi.fn(),
}));

import { ESIGN_MERGE_FIELD_NAMES } from "./types";
import { templateLibraryActions } from "./client-actions";

describe("template browser staging transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepare.mockResolvedValue({
      ok: true,
      data: {
        stagingSourceId: "123e4567-e89b-42d3-a456-426614174000",
        bucket: "esign-staging",
        storagePath: "org-1/123e4567-e89b-42d3-a456-426614174000.pdf",
      },
    });
    mocks.upload.mockResolvedValue({ error: null });
    mocks.create.mockResolvedValue({
      ok: true,
      data: { templateId: "template-1", initialEditorSession: null },
    });
  });

  it("fails safely when Dropbox Chooser has no approved app key", async () => {
    vi.stubEnv("NEXT_PUBLIC_DROPBOX_CHOOSER_APP_KEY", "");
    await expect(templateLibraryActions.pickDropboxPdf()).resolves.toEqual({
      ok: false,
      error: {
        code: "DROPBOX_CHOOSER_UNAVAILABLE",
        message: "Dropbox Chooser could not be loaded.",
      },
    });
  });

  it("uploads PDF bytes directly to the authorized private path and sends only compact metadata to the action", async () => {
    const file = new File(
      [new TextEncoder().encode("%PDF-1.7\nbody")],
      "offer.pdf",
      { type: "application/pdf" },
    );
    await expect(
      templateLibraryActions.createDraft({
        name: "Offer",
        documentType: "Purchase agreement",
        source: { file, origin: "upload" },
        signerRoles: [{ name: "Seller", order: 0 }],
        sellerRoleName: "Seller",
        mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
      }),
    ).resolves.toEqual({
      ok: true,
      data: { templateId: "template-1", initialEditorSession: null },
    });

    expect(mocks.upload).toHaveBeenCalledWith(
      "esign-staging",
      "org-1/123e4567-e89b-42d3-a456-426614174000.pdf",
      file,
      { contentType: "application/pdf", upsert: false },
    );
    const payload = mocks.create.mock.calls[0]?.[0];
    expect(payload.source).toEqual(
      expect.objectContaining({
        stagingSourceId: "123e4567-e89b-42d3-a456-426614174000",
        bucket: "esign-staging",
        storagePath: "org-1/123e4567-e89b-42d3-a456-426614174000.pdf",
        filename: "offer.pdf",
        size: file.size,
        mimeType: "application/pdf",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(payload.source).not.toHaveProperty("file");
    expect(payload.source).not.toHaveProperty("bytes");
    expect(JSON.stringify(payload).length).toBeLessThan(2_048);
  });

  it("replays the exact caller-owned reservation ID instead of creating a second source", async () => {
    const file = new File(["%PDF-"], "offer.pdf", { type: "application/pdf" });
    const input = {
      name: "Offer",
      documentType: "Purchase agreement",
      source: { file, origin: "upload" as const },
      signerRoles: [{ name: "Seller", order: 0 }],
      sellerRoleName: "Seller",
      mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
    };

    await templateLibraryActions.createDraft(input, {
      stagingSourceId: "123e4567-e89b-42d3-a456-426614174000",
    });
    await templateLibraryActions.createDraft(input, {
      stagingSourceId: "123e4567-e89b-42d3-a456-426614174000",
    });

    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(mocks.prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        stagingSourceId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    );
    expect(mocks.prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        stagingSourceId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    );
  });

  it("never invokes the create action when direct private upload fails", async () => {
    mocks.upload.mockResolvedValue({ error: { message: "denied" } });
    const file = new File(["%PDF-"], "offer.pdf", { type: "application/pdf" });
    const result = await templateLibraryActions.createDraft({
      name: "Offer",
      documentType: "Purchase agreement",
      source: { file, origin: "upload" },
      signerRoles: [{ name: "Seller", order: 0 }],
      sellerRoleName: "Seller",
      mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STAGING_UPLOAD_REQUIRES_RECOVERY" },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("never invokes create after a standard upload resolves late following cancellation", async () => {
    let finishUpload!: (value: { error: null }) => void;
    mocks.upload.mockReturnValueOnce(
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
    );
    const controller = new AbortController();
    const file = new File(["%PDF-"], "offer.pdf", { type: "application/pdf" });
    const pending = templateLibraryActions.createDraft(
      {
        name: "Offer",
        documentType: "Purchase agreement",
        source: { file, origin: "upload" },
        signerRoles: [{ name: "Seller", order: 0 }],
        sellerRoleName: "Seller",
        mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    controller.abort();
    finishUpload({ error: null });
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "STAGING_UPLOAD_REQUIRES_RECOVERY" },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("never uploads or creates for a pre-aborted standard attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    const file = new File(["%PDF-"], "offer.pdf", { type: "application/pdf" });
    await expect(
      templateLibraryActions.createDraft(
        {
          name: "Offer",
          documentType: "Purchase agreement",
          source: { file, origin: "upload" },
          signerRoles: [{ name: "Seller", order: 0 }],
          sellerRoleName: "Seller",
          mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
        },
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "STAGING_UPLOAD_REQUIRES_RECOVERY" },
    });
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("never infers absence or deletes from an ambiguous browser upload error", async () => {
    mocks.upload.mockResolvedValue({ error: { message: "ambiguous" } });
    const file = new File(["%PDF-"], "offer.pdf", { type: "application/pdf" });
    const result = await templateLibraryActions.createDraft({
      name: "Offer",
      documentType: "Purchase agreement",
      source: { file, origin: "upload" },
      signerRoles: [{ name: "Seller", order: 0 }],
      sellerRoleName: "Seller",
      mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STAGING_UPLOAD_REQUIRES_RECOVERY" },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
