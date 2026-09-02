import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

import { ESIGN_MERGE_FIELD_NAMES } from "./contracts";
import { registerDropboxWebsiteTemplate } from "./website-template-registration";

const mocks = vi.hoisted(() => ({
  getEsignCredentials: vi.fn(),
  getTemplate: vi.fn(),
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
  createAdminClient: () => ({ rpc: mocks.rpc }),
}));

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
      signerRoles: [{ name: "Seller", order: 0 }],
      mergeFieldNames: [...ESIGN_MERGE_FIELD_NAMES],
    });
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
          signerRoles: [{ name: "Seller", order: 0 }],
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
      signerRoles: [{ name: "Seller", order: 0 }],
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
});
