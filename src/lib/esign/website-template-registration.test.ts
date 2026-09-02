import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

import { ESIGN_MERGE_FIELD_NAMES } from "./contracts";
import {
  registerDropboxWebsiteTemplate,
  revalidateDropboxWebsiteTemplate,
} from "./website-template-registration";

const mocks = vi.hoisted(() => ({
  getEsignCredentials: vi.fn(),
  getTemplate: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("./credentials", () => ({
  getEsignCredentials: mocks.getEsignCredentials,
}));

vi.mock("./dropbox-sign", () => ({
  createDropboxSignProvider: () => ({
    getTemplate: mocks.getTemplate,
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));

function templateQuery(
  row: {
    id: string;
    org_id: string;
    name: string;
    document_type: string;
    provider_account_id: string | null;
    sign_template_id: string | null;
    template_origin: string;
  } | null = {
    id: "template-local-1",
    org_id: "org-1",
    name: "Local label",
    document_type: "Local document type",
    provider_account_id: "provider-account-1",
    sign_template_id: "provider-template-1",
    template_origin: "dropbox_website",
  },
) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const secondEq = vi.fn(() => ({ maybeSingle }));
  const firstEq = vi.fn(() => ({ eq: secondEq }));
  return {
    select: vi.fn(() => ({ eq: firstEq })),
  };
}

describe("Dropbox website eSign template registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEsignCredentials.mockResolvedValue({
      apiKey: "test-api-key",
      clientId: "client-id",
      providerAccountId: "provider-account-1",
      sendingEnabled: false,
      testMode: true,
    });
    mocks.getTemplate.mockResolvedValue({
      providerTemplateId: "provider-template-1",
      localTemplateId: null,
      title: "Provider title",
      isEmbedded: false,
      canEdit: true,
      isCreator: true,
      isLocked: false,
      accounts: [{ accountId: "provider-account-1", isLocked: false }],
      signerRoles: [
        { name: "Seller", order: 0 },
        { name: "Buyer", order: 1 },
      ],
      mergeFieldNames: [...ESIGN_MERGE_FIELD_NAMES],
    });
    mocks.from.mockReturnValue(templateQuery());
    mocks.rpc.mockResolvedValue({
      data: [{ outcome: "registered", template_id: "template-local-1" }],
      error: null,
    });
  });

  it("attests non-embedded Dropbox website metadata before registering", async () => {
    await expect(
      registerDropboxWebsiteTemplate({
        orgId: "org-1",
        actorId: "user-1",
        providerTemplateId: "provider-template-1",
        name: "Purchase agreement",
        documentType: "Purchase agreement",
      }),
    ).resolves.toMatchObject({
      id: "template-local-1",
      providerTemplateId: "provider-template-1",
      sellerRoleName: "Seller",
      mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
    });

    expect(mocks.getTemplate).toHaveBeenCalledWith("provider-template-1");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "register_dropbox_website_esign_template",
      expect.objectContaining({
        p_org_id: "org-1",
        p_actor_id: "user-1",
        p_provider_account_id: "provider-account-1",
        p_provider_template_id: "provider-template-1",
        p_provider_metadata: expect.objectContaining({
          isEmbedded: false,
          canEdit: true,
          isLocked: false,
          accounts: [{ accountId: "provider-account-1", isLocked: false }],
          signerRoles: [
            { name: "Seller", order: 0 },
            { name: "Buyer", order: 1 },
          ],
          mergeFieldNames: [...ESIGN_MERGE_FIELD_NAMES],
        }),
      }),
    );
  });

  it("rejects embedded templates before registration", async () => {
    mocks.getTemplate.mockResolvedValue({
      providerTemplateId: "provider-template-1",
      localTemplateId: null,
      title: "Provider title",
      isEmbedded: true,
      canEdit: true,
      isCreator: true,
      isLocked: false,
      accounts: [{ accountId: "provider-account-1", isLocked: false }],
      signerRoles: [
        { name: "Seller", order: 0 },
        { name: "Buyer", order: 1 },
      ],
      mergeFieldNames: [...ESIGN_MERGE_FIELD_NAMES],
    });

    await expect(
      registerDropboxWebsiteTemplate({
        orgId: "org-1",
        actorId: "user-1",
        providerTemplateId: "provider-template-1",
        name: "Purchase agreement",
        documentType: "Purchase agreement",
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects duplicate merge fields by raw count before registration", async () => {
    mocks.getTemplate.mockResolvedValue({
      providerTemplateId: "provider-template-1",
      localTemplateId: null,
      title: "Provider title",
      isEmbedded: false,
      canEdit: true,
      isCreator: true,
      isLocked: false,
      accounts: [{ accountId: "provider-account-1", isLocked: false }],
      signerRoles: [
        { name: "Seller", order: 0 },
        { name: "Buyer", order: 1 },
      ],
      mergeFieldNames: [
        "seller_name",
        "seller_name",
        "property_address",
        "offer_price",
        "closing_date",
      ],
    });

    await expect(
      registerDropboxWebsiteTemplate({
        orgId: "org-1",
        actorId: "user-1",
        providerTemplateId: "provider-template-1",
        name: "Purchase agreement",
        documentType: "Purchase agreement",
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("revalidates the canonical stored provider id while preserving local label metadata", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ outcome: "existing", template_id: "template-local-1" }],
      error: null,
    });

    await expect(
      revalidateDropboxWebsiteTemplate({
        orgId: "org-1",
        actorId: "user-1",
        templateId: "template-local-1",
        providerTemplateId: "caller-supplied-id-is-ignored",
      }),
    ).resolves.toBe("valid");

    expect(mocks.getTemplate).toHaveBeenCalledWith("provider-template-1");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "register_dropbox_website_esign_template",
      expect.objectContaining({
        p_name: "Local label",
        p_document_type: "Local document type",
        p_provider_template_id: "provider-template-1",
      }),
    );
  });

  it("leaves transient provider failures transient during revalidation", async () => {
    mocks.getTemplate.mockRejectedValue(
      new ProviderError("rate limited", "dropbox_sign", {
        statusCode: 429,
        retryable: true,
      }),
    );

    await expect(
      revalidateDropboxWebsiteTemplate({
        orgId: "org-1",
        actorId: "user-1",
        templateId: "template-local-1",
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "mark_dropbox_website_esign_template_unavailable",
      expect.anything(),
    );
  });

  it("marks definitive provider drift unavailable without trusting a caller provider id", async () => {
    mocks.getTemplate.mockRejectedValue(
      new ProviderError("not found", "dropbox_sign", { statusCode: 404 }),
    );
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });

    await expect(
      revalidateDropboxWebsiteTemplate({
        orgId: "org-1",
        actorId: "user-1",
        templateId: "template-local-1",
        providerTemplateId: "wrong-provider-id",
      }),
    ).resolves.toBe("unavailable");

    expect(mocks.getTemplate).toHaveBeenCalledWith("provider-template-1");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "mark_dropbox_website_esign_template_unavailable",
      {
        p_org_id: "org-1",
        p_actor_id: "user-1",
        p_template_id: "template-local-1",
        p_reason: "PROVIDER_METADATA_DRIFT",
      },
    );
  });
});
