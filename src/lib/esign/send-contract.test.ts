import { describe, expect, it, vi } from "vitest";

import {
  ESIGN_MERGE_FIELD_NAMES,
  type DropboxSignProvider,
  type ProviderSignature,
  type TemplateOption,
} from "./contracts";
import {
  sendContractWithTemplate,
  type ProviderSendContractInput,
} from "./send-contract";

const template: TemplateOption = {
  id: "template-local-1",
  name: "Purchase agreement",
  documentType: "purchase_agreement",
  providerTemplateId: "provider-template-1",
  sellerRoleName: "Seller",
  signerRoles: [
    { name: "Seller", order: 0 },
    { name: "Buyer", order: 1 },
  ],
  mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
};

const signers = [
  {
    role: "Seller",
    order: 0,
    name: "Seller Owner",
    emailAddress: "seller@example.com",
  },
  {
    role: "Buyer",
    order: 1,
    name: "Buyer One",
    emailAddress: "buyer@example.com",
  },
] as const;

const mergeValues = {
  seller_name: "Seller Owner",
  property_address: "123 Main St",
  offer_price: "$125,000",
  closing_date: "2026-09-30",
  earnest_money: "$1,000",
} as const;

const providerSignatures: readonly ProviderSignature[] = signers.map(
  (signer, index) => ({
    signatureId: `signature-${index + 1}`,
    ...signer,
  }),
);

function input(
  overrides: Partial<ProviderSendContractInput> = {},
): ProviderSendContractInput {
  return {
    localRequestId: "request-local-1",
    template,
    signers,
    mergeValues,
    title: "Purchase agreement",
    ...overrides,
  };
}

function provider(
  overrides: Partial<DropboxSignProvider> = {},
): DropboxSignProvider {
  return {
    validateCredentials: vi.fn(),
    createEmbeddedTemplateDraft: vi.fn(),
    getEmbeddedTemplateEditUrl: vi.fn(),
    getTemplate: vi.fn(),
    getTemplateFiles: vi.fn(),
    duplicateTemplate: vi.fn(),
    updateTemplateFiles: vi.fn(),
    deleteTemplate: vi.fn(),
    sendWithTemplate: vi.fn().mockResolvedValue({
      signatureRequestId: "provider-request-1",
      signatures: providerSignatures,
      detailsUrl:
        "https://app.hellosign.com/home/manage?guid=provider-request-1",
      testMode: true,
    }),
    updateSignerEmail: vi.fn(),
    findSignatureRequestIdsByLocalRequestId: vi.fn(),
    getSignatureRequestMetadata: vi.fn(),
    remind: vi.fn(),
    cancel: vi.fn(),
    downloadSignedPdf: vi.fn(),
    ...overrides,
  };
}

describe("sendContractWithTemplate", () => {
  it("uses the provider template id and exact ordered roles and merge fields", async () => {
    const adapter = provider();

    const result = await sendContractWithTemplate(adapter, input());

    expect(adapter.sendWithTemplate).toHaveBeenCalledWith({
      localRequestId: "request-local-1",
      testMode: true,
      templateId: "provider-template-1",
      signers: [
        {
          role: "Seller",
          name: "Seller Owner",
          emailAddress: "seller@example.com",
        },
        {
          role: "Buyer",
          name: "Buyer One",
          emailAddress: "buyer@example.com",
        },
      ],
      mergeValues,
      title: "Purchase agreement",
      subject: undefined,
      message: undefined,
    });
    expect(result.detailsUrl).toContain("/home/manage");
    expect(result).not.toHaveProperty("signingUrl");
  });

  it.each([
    {
      name: "missing role",
      value: signers.slice(0, 1),
    },
    {
      name: "extra role",
      value: [
        ...signers,
        {
          role: "Attorney",
          order: 2,
          name: "Attorney",
          emailAddress: "attorney@example.com",
        },
      ],
    },
    {
      name: "case-changed role",
      value: [{ ...signers[0], role: "seller" }, signers[1]],
    },
  ])(
    "rejects a $name assignment before calling Dropbox Sign",
    async ({ value }) => {
      const adapter = provider();

      await expect(
        sendContractWithTemplate(
          adapter,
          input({ signers: value as ProviderSendContractInput["signers"] }),
        ),
      ).rejects.toThrow("Assign exactly one signer to every template role.");
      expect(adapter.sendWithTemplate).not.toHaveBeenCalled();
    },
  );

  it.each([
    "seller@@example.com",
    "seller name@example.com",
    "seller@exa mple.com",
    "@example.com",
    "seller@",
  ])(
    "rejects malformed signer email %j before provider dispatch",
    async (emailAddress) => {
      const adapter = provider();

      await expect(
        sendContractWithTemplate(
          adapter,
          input({
            signers: [{ ...signers[0], emailAddress }, signers[1]],
          }),
        ),
      ).rejects.toThrow("Assign exactly one signer to every template role.");
      expect(adapter.sendWithTemplate).not.toHaveBeenCalled();
    },
  );

  it("rejects a stale template role snapshot", async () => {
    const adapter = provider();
    const staleTemplate = {
      ...template,
      signerRoles: [
        { name: "Seller", order: 0 },
        { name: "Buyer", order: 2 },
      ],
    };

    await expect(
      sendContractWithTemplate(adapter, input({ template: staleTemplate })),
    ).rejects.toThrow("template signer roles are no longer valid");
    expect(adapter.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("rejects merge values with missing or unexpected keys", async () => {
    const adapter = provider();
    const invalidValues = {
      ...mergeValues,
      unexpected_field: "not allowed",
    } as ProviderSendContractInput["mergeValues"];

    await expect(
      sendContractWithTemplate(adapter, input({ mergeValues: invalidValues })),
    ).rejects.toThrow("five required contract fields");
    expect(adapter.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("accepts the exact case-sensitive merge-field set in provider order", async () => {
    const adapter = provider();
    const providerOrderedTemplate = {
      ...template,
      mergeFieldNames: [...ESIGN_MERGE_FIELD_NAMES].reverse(),
    } as unknown as TemplateOption;

    await expect(
      sendContractWithTemplate(
        adapter,
        input({ template: providerOrderedTemplate }),
      ),
    ).resolves.toMatchObject({ signatureRequestId: "provider-request-1" });
  });

  it("rejects blank required merge values", async () => {
    const adapter = provider();

    await expect(
      sendContractWithTemplate(
        adapter,
        input({ mergeValues: { ...mergeValues, closing_date: " " } }),
      ),
    ).rejects.toThrow("five required contract fields");
    expect(adapter.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("rejects a response without a manager details URL", async () => {
    const adapter = provider({
      sendWithTemplate: vi.fn().mockResolvedValue({
        signatureRequestId: "provider-request-1",
        signatures: providerSignatures,
        detailsUrl: null,
        testMode: true,
      }),
    });

    await expect(sendContractWithTemplate(adapter, input())).rejects.toThrow(
      "manager details URL",
    );
  });

  it("rejects provider signer details that differ from the immutable send snapshot", async () => {
    const adapter = provider({
      sendWithTemplate: vi.fn().mockResolvedValue({
        signatureRequestId: "provider-request-1",
        signatures: [
          { ...providerSignatures[0], role: "seller" },
          providerSignatures[1],
        ],
        detailsUrl:
          "https://app.hellosign.com/home/manage?guid=provider-request-1",
        testMode: true,
      }),
    });

    await expect(sendContractWithTemplate(adapter, input())).rejects.toThrow(
      "signer details that do not match",
    );
  });
});
