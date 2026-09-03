import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberships: vi.fn(),
  factory: vi.fn(),
  report: vi.fn(),
  initialFactory: vi.fn(),
  prepareUpload: vi.fn(),
  createInitial: vi.fn(),
  createReplacement: vi.fn(),
  cleanupInitial: vi.fn(),
  reconcileInitial: vi.fn(),
  promoteInitial: vi.fn(),
  retryProviderInitial: vi.fn(),
  registerWebsiteTemplate: vi.fn(),
  revalidateWebsiteTemplate: vi.fn(),
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
vi.mock("@/lib/auth/memberships", () => ({
  getSingleActiveMembership: async () => {
    const memberships = await mocks.memberships();
    if (memberships.length === 0) return { ok: false, reason: "missing" };
    if (memberships.length !== 1) return { ok: false, reason: "ambiguous" };
    return { ok: true, membership: memberships[0] };
  },
}));
vi.mock("@/lib/esign/template-foundation-adapter", () => ({
  createFoundationTemplateOrchestrator: mocks.factory,
}));
vi.mock("@/lib/esign/template-initial-runtime", () => ({
  createInitialTemplateRuntime: mocks.initialFactory,
}));
vi.mock("@/lib/esign/website-template-registration", () => ({
  registerDropboxWebsiteTemplate: mocks.registerWebsiteTemplate,
  revalidateDropboxWebsiteTemplate: mocks.revalidateWebsiteTemplate,
}));

import { DatabaseError, ProviderError } from "@/lib/errors/classes";
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
  retryInitialTemplateProviderCreateAction,
  restartTemplatePlacementAction,
  registerWebsiteTemplateAction,
} from "./actions";

describe("template server action boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberships.mockResolvedValue([
      { user_id: "owner-1", org_id: "org-1", role: "owner" },
    ]);
    mocks.prepareUpload.mockResolvedValue({
      ok: true,
      data: {
        stagingSourceId: "source-1",
        bucket: "esign-staging",
        storagePath: "org-1/source-1.pdf",
      },
    });
    mocks.createInitial.mockResolvedValue({
      ok: true,
      data: { templateId: "template-1", initialEditorSession: null },
    });
    mocks.createReplacement.mockImplementation(
      async (
        _templateId: string,
        beforeProviderCreate: (replacementTemplateId: string) => Promise<unknown>,
      ) => {
        const retired = await beforeProviderCreate("replacement-1") as {
          ok: boolean;
          data?: { cleanupAttention: boolean };
        };
        if (!retired.ok) return retired;
        return {
          ok: true,
          data: {
            templateId: "replacement-1",
            initialEditorSession: {
              providerTemplateId: "provider-replacement",
              editUrl: "https://app.hellosign.com/editor/replacement",
              expiresAt: 1_999_999_999,
              clientId: "client-1",
            },
            cleanupAttention: retired.data?.cleanupAttention ?? false,
          },
        };
      },
    );
    mocks.cleanupInitial.mockResolvedValue({ ok: true, data: null });
    mocks.reconcileInitial.mockResolvedValue({
      ok: true,
      data: { templateId: "template-1" },
    });
    mocks.promoteInitial.mockResolvedValue({
      ok: true,
      data: { templateId: "template-1", providerCreateState: "unknown" },
    });
    mocks.retryProviderInitial.mockResolvedValue({
      ok: true,
      data: {
        templateId: "template-1",
        initialEditorSession: {
          providerTemplateId: "provider-1",
          editUrl: "https://app.hellosign.com/editor/retry",
          expiresAt: 1_999_999_999,
          clientId: "client-1",
        },
      },
    });
    mocks.registerWebsiteTemplate.mockResolvedValue({
      id: "website-template-1",
      name: "Website template",
      documentType: "Purchase agreement",
      providerTemplateId: "provider-template-1",
      sellerRoleName: "Seller",
      signerRoles: [
        { name: "Seller", order: 0 },
        { name: "Buyer", order: 1 },
      ],
      mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
    });
    mocks.revalidateWebsiteTemplate.mockResolvedValue("valid");
    mocks.initialFactory.mockResolvedValue({
      prepare: mocks.prepareUpload,
      create: mocks.createInitial,
      createReplacementFromRetainedSource: mocks.createReplacement,
      cleanupSource: mocks.cleanupInitial,
      reconcileUnknown: mocks.reconcileInitial,
      promoteStaleProviderCreate: mocks.promoteInitial,
      retryProviderCreate: mocks.retryProviderInitial,
    });
    mocks.verifyStagedSource.mockResolvedValue({
      ok: true,
      data: { stagingSourceId: "source-1" },
    });
    mocks.add.mockResolvedValue({
      ok: true,
      data: { templateId: "template-1" },
    });
    mocks.duplicate.mockResolvedValue({
      ok: true,
      data: { templateId: "copy-1", readiness: "pending" },
    });
    mocks.beginEditRevision.mockResolvedValue({
      ok: true,
      data: { templateId: "revision-1", readiness: "pending" },
    });
    mocks.delete.mockResolvedValue({ ok: true, data: null });
    mocks.checkEditorReadiness.mockResolvedValue({
      ok: true,
      data: { readiness: "pending" },
    });
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
    mocks.memberships.mockResolvedValue([
      { user_id: "member-1", org_id: "org-1", role: "member" },
    ]);
    await expect(deleteTemplateAction("template-1")).resolves.toEqual({
      ok: false,
      error: {
        code: "OWNER_REQUIRED",
        message: "Only an organization owner can manage eSign templates.",
      },
    });
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it("returns safe actionable messages for known website template provider validation", async () => {
    mocks.registerWebsiteTemplate.mockRejectedValueOnce(
      new ProviderError("private provider detail", "dropbox_sign", {
        providerCode: "merge_field_mismatch",
      }),
    );

    await expect(
      registerWebsiteTemplateAction({
        providerTemplateId: "provider-template-1",
        name: "Purchase agreement",
        documentType: "Purchase agreement",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "MERGE_FIELD_MISMATCH",
        message:
          "Dropbox Sign Sender merge fields must be exactly seller_name, property_address, offer_price, closing_date, and earnest_money.",
      },
    });
  });

  it("keeps website template database failures generic", async () => {
    mocks.registerWebsiteTemplate.mockRejectedValueOnce(
      new DatabaseError("duplicate provider-template pair private detail"),
    );

    await expect(
      registerWebsiteTemplateAction({
        providerTemplateId: "provider-template-1",
        name: "Purchase agreement",
        documentType: "Purchase agreement",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "ESIGN_TEMPLATE_ACTION_FAILED",
        message: "The eSign template action could not be completed.",
      },
    });
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

  it("returns the provider's initial editor session through the Server Action", async () => {
    const initialEditorSession = {
      providerTemplateId: "provider-1",
      editUrl: "https://app.hellosign.com/editor/initial",
      expiresAt: 1_999_999_999,
      clientId: "client-1",
    };
    mocks.createInitial.mockResolvedValueOnce({
      ok: true,
      data: { templateId: "template-1", initialEditorSession },
    });
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
    expect(result).toEqual({
      ok: true,
      data: { templateId: "template-1", initialEditorSession },
    });
  });

  it("retries a released provider create through the owner-scoped runtime", async () => {
    await expect(retryInitialTemplateProviderCreateAction("template-1")).resolves.toEqual({
      ok: true,
      data: {
        templateId: "template-1",
        initialEditorSession: {
          providerTemplateId: "provider-1",
          editUrl: "https://app.hellosign.com/editor/retry",
          expiresAt: 1_999_999_999,
          clientId: "client-1",
        },
      },
    });
    expect(mocks.retryProviderInitial).toHaveBeenCalledWith("template-1");
    expect(mocks.revalidate).toHaveBeenCalledWith("/settings/esign-templates");
  });

  it("retires the stuck provider draft before creating its replacement", async () => {
    const order: string[] = [];
    mocks.abandon.mockImplementation(async () => {
      order.push("retire-original-provider");
      return { ok: true, data: null };
    });
    mocks.createReplacement.mockImplementationOnce(
      async (_templateId: string, beforeProviderCreate: (replacementTemplateId: string) => Promise<unknown>) => {
        order.push("reserve-replacement");
        await beforeProviderCreate("replacement-1");
        order.push("create-replacement-provider");
        return {
          ok: true,
          data: {
            templateId: "replacement-1",
            initialEditorSession: {
              providerTemplateId: "provider-replacement",
              editUrl: "https://app.hellosign.com/editor/replacement",
              expiresAt: 1_999_999_999,
              clientId: "client-1",
            },
            cleanupAttention: false,
          },
        };
      },
    );
    const result = await restartTemplatePlacementAction("template-1");

    expect(result).toEqual({
      ok: true,
      data: {
        templateId: "replacement-1",
        initialEditorSession: {
          providerTemplateId: "provider-replacement",
          editUrl: "https://app.hellosign.com/editor/replacement",
          expiresAt: 1_999_999_999,
          clientId: "client-1",
        },
        cleanupAttention: false,
      },
    });
    expect(mocks.createReplacement).toHaveBeenCalledWith(
      "template-1",
      expect.any(Function),
    );
    expect(order).toEqual([
      "reserve-replacement",
      "retire-original-provider",
      "create-replacement-provider",
    ]);
    expect(mocks.abandon).toHaveBeenCalledWith("template-1");
    expect(mocks.abandon).not.toHaveBeenCalledWith("replacement-1");
    expect(mocks.revalidate).toHaveBeenCalledWith("/settings/esign-templates");
  });

  it("keeps the replacement usable while surfacing original-source cleanup attention", async () => {
    mocks.abandon.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "SOURCE_CLEANUP_FAILED",
        message: "The draft was removed but its private source still needs cleanup.",
      },
    });

    const result = await restartTemplatePlacementAction("template-1");

    expect(result).toMatchObject({
      ok: true,
      data: {
        templateId: "replacement-1",
        cleanupAttention: true,
      },
    });
    expect(mocks.abandon).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledWith("/settings/esign-templates");
  });

  it("does not create a provider replacement until the original slot is released", async () => {
    mocks.abandon.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "PLACEMENT_RESTART_PROVIDER_RETIRE_FAILED",
        message: "Dropbox Sign could not release the unfinished template slot.",
      },
    });

    const result = await restartTemplatePlacementAction("template-1");

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PLACEMENT_RESTART_PROVIDER_RETIRE_FAILED",
        message: "Dropbox Sign could not release the unfinished template slot.",
      },
    });
    expect(mocks.abandon).toHaveBeenCalledOnce();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("does not create the provider replacement until local retirement is durable", async () => {
    mocks.abandon.mockResolvedValueOnce({
        ok: false,
        error: {
          code: "ABANDON_LOCAL_FAILED",
          message: "The provider draft was removed but local retirement failed.",
        },
      });

    const result = await restartTemplatePlacementAction("template-1");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ABANDON_LOCAL_FAILED" },
    });
    expect(mocks.abandon).toHaveBeenCalledOnce();
    expect(mocks.abandon).not.toHaveBeenCalledWith("replacement-1");
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("runs both concurrent restarts while preserving the winner's one-time session", async () => {
    let call = 0;
    mocks.createReplacement.mockImplementation(
      async (_templateId: string, beforeProviderCreate: (replacementTemplateId: string) => Promise<unknown>) => {
        await beforeProviderCreate("replacement-1");
        call += 1;
        return {
          ok: true,
          data: {
            templateId: "replacement-1",
            initialEditorSession:
              call === 1
                ? {
                    providerTemplateId: "provider-replacement",
                    editUrl: "https://app.hellosign.com/editor/replacement",
                    expiresAt: 1_999_999_999,
                    clientId: "client-1",
                  }
                : null,
            cleanupAttention: false,
          },
        };
      },
    );

    const [winner, follower] = await Promise.all([
      restartTemplatePlacementAction("template-1"),
      restartTemplatePlacementAction("template-1"),
    ]);

    expect(winner).toMatchObject({
      ok: true,
      data: { templateId: "replacement-1" },
    });
    expect(follower).toEqual({
      ok: false,
      error: {
        code: "PLACEMENT_RESTART_IN_PROGRESS",
        message:
          "Another restart already created this replacement. Return to the template library to continue or clean it up.",
      },
    });
    expect(mocks.createReplacement).toHaveBeenCalledTimes(2);
    expect(mocks.abandon).toHaveBeenCalledTimes(2);
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
    expect(result).toEqual({
      ok: true,
      data: { templateId: "template-1", initialEditorSession: null },
    });
    expect(mocks.createInitial).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          filename: "offer.pdf",
          mimeType: "application/pdf",
          size: 14,
        }),
      }),
    );
    const actionPayload = mocks.createInitial.mock.calls[0]?.[0];
    expect(actionPayload).not.toHaveProperty("file");
    expect(actionPayload).not.toHaveProperty("bytes");
    expect(JSON.stringify(actionPayload).length).toBeLessThan(1_024);
  });

  it("keeps unexpected database/provider diagnostics out of the returned Result", async () => {
    mocks.factory.mockRejectedValue(
      new Error("secret SQL detail api_key=private"),
    );
    const result = await duplicateTemplateAction("template-1", "Copy");
    expect(result).toEqual({
      ok: false,
      error: {
        code: "ESIGN_TEMPLATE_ACTION_FAILED",
        message: "The eSign template action could not be completed.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(mocks.report).toHaveBeenCalled();
  });

  it("routes claimed recovery and manual reconciliation through typed server actions", async () => {
    await expect(
      reconcileUnknownTemplateProviderAction("template-1", "provider-1"),
    ).resolves.toEqual({
      ok: true,
      data: { templateId: "template-1" },
    });
    await expect(
      promoteStaleInitialTemplateProviderCreateAction("template-1"),
    ).resolves.toEqual({
      ok: true,
      data: { templateId: "template-1", providerCreateState: "unknown" },
    });
    expect(mocks.reconcileInitial).toHaveBeenCalledWith(
      "template-1",
      "provider-1",
    );
    expect(mocks.promoteInitial).toHaveBeenCalledWith("template-1");
  });

  it("passes the explicit recent-send confirmation into the atomic delete RPC path", async () => {
    await deleteTemplateAction("template-1", true);
    expect(mocks.delete).toHaveBeenCalledWith("template-1", true);
    expect(mocks.revalidate).toHaveBeenCalledWith("/settings/esign-templates");
  });

  it("preserves duplicate and readiness states through the safe action boundary", async () => {
    await expect(
      duplicateTemplateAction("template-1", "Copy"),
    ).resolves.toEqual({
      ok: true,
      data: { templateId: "copy-1", readiness: "pending" },
    });
    await expect(checkTemplateEditorReadinessAction("copy-1")).resolves.toEqual(
      {
        ok: true,
        data: { readiness: "pending" },
      },
    );
  });

  it("preserves hidden edit-revision readiness and revalidates recovery", async () => {
    await expect(
      beginTemplateEditRevisionAction("template-1"),
    ).resolves.toEqual({
      ok: true,
      data: { templateId: "revision-1", readiness: "pending" },
    });
    expect(mocks.beginEditRevision).toHaveBeenCalledWith("template-1");
    expect(mocks.revalidate).toHaveBeenCalledWith("/settings/esign-templates");
  });

  it("revalidates the server-backed recovery list after a successful cancel", async () => {
    await expect(abandonTemplateDraftAction("copy-1")).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(mocks.abandon).toHaveBeenCalledWith("copy-1");
    expect(mocks.revalidate).toHaveBeenCalledWith("/settings/esign-templates");
  });

  it("revalidates the recovery list after cleanup convergence", async () => {
    await expect(retryTemplateSourceCleanupAction("copy-1")).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(mocks.retryCleanup).toHaveBeenCalledWith("copy-1");
    expect(mocks.revalidate).toHaveBeenCalledWith("/settings/esign-templates");
  });
});
