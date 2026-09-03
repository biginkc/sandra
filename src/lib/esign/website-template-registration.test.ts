import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

import { ESIGN_MERGE_FIELD_NAMES, type ProviderTemplateMetadata } from "./contracts";
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

function field(
  name: string,
  overrides: Partial<ProviderTemplateMetadata["mergeFields"][number]> = {},
): ProviderTemplateMetadata["mergeFields"][number] {
  return {
    documentIndex: 0,
    apiId: `${name}-api`,
    name,
    type: "text",
    required: false,
    signer: null,
    assignedTo: "sender",
    signerRoleName: null,
    ...overrides,
  };
}

function metadata(
  overrides: Partial<ProviderTemplateMetadata> = {},
): ProviderTemplateMetadata {
  const mergeFields = ESIGN_MERGE_FIELD_NAMES.map((name) => field(name));
  const formFields: ProviderTemplateMetadata["formFields"] = [
    field("seller_signature", {
      apiId: "seller-signature-api",
      type: "signature",
      required: true,
      signer: "1",
      assignedTo: "signer",
      signerRoleName: "Seller",
    }),
    field("buyer_signature", {
      apiId: "buyer-signature-api",
      type: "signature",
      required: true,
      signer: "2",
      assignedTo: "signer",
      signerRoleName: "Buyer",
    }),
  ];
  const documents = [
    {
      index: 0,
      name: "purchase-agreement.pdf",
      customFields: mergeFields,
      formFields,
    },
  ];
  return {
    providerTemplateId: "provider-template-1",
    localTemplateId: null,
    title: "Provider title",
    isEmbedded: false,
    canEdit: null,
    isCreator: null,
    isLocked: false,
    accounts: [{ accountId: "provider-account-1", isLocked: null }],
    signerRoles: [
      { name: "Seller", order: 0 },
      { name: "Buyer", order: 1 },
    ],
    mergeFieldNames: [...ESIGN_MERGE_FIELD_NAMES],
    documents,
    mergeFields,
    formFields,
    ...overrides,
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
    mocks.getTemplate.mockResolvedValue(metadata());
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
          canEdit: null,
          isLocked: false,
          accounts: [{ accountId: "provider-account-1", isLocked: null }],
          signerRoles: [
            { name: "Seller", order: 0 },
            { name: "Buyer", order: 1 },
          ],
          mergeFieldNames: [...ESIGN_MERGE_FIELD_NAMES],
          documents: [
            expect.objectContaining({
              customFields: expect.arrayContaining([
                expect.objectContaining({
                  name: "seller_name",
                  assignedTo: "sender",
                  signer: null,
                }),
              ]),
              formFields: expect.arrayContaining([
                expect.objectContaining({
                  type: "signature",
                  signerRoleName: "Seller",
                }),
                expect.objectContaining({
                  type: "signature",
                  signerRoleName: "Buyer",
                }),
              ]),
            }),
          ],
        }),
      }),
    );
  });

  it("rejects embedded templates before registration", async () => {
    mocks.getTemplate.mockResolvedValue(metadata({ isEmbedded: true }));

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
    const duplicateFields = [
      field("seller_name"),
      field("seller_name", { apiId: "seller-name-duplicate-api" }),
      field("property_address"),
      field("offer_price"),
      field("closing_date"),
    ];
    mocks.getTemplate.mockResolvedValue(metadata({
      mergeFieldNames: [
        "seller_name",
        "seller_name",
        "property_address",
        "offer_price",
        "closing_date",
      ],
      mergeFields: duplicateFields,
      documents: [
        {
          index: 0,
          name: "purchase-agreement.pdf",
          customFields: duplicateFields,
          formFields: metadata().formFields,
        },
      ],
    }));

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

  it("rejects the canonical five plus an extra Sender custom field", async () => {
    const customFields = [
      ...ESIGN_MERGE_FIELD_NAMES.map((name) => field(name)),
      field("unexpected_sender_field"),
    ];
    mocks.getTemplate.mockResolvedValue(metadata({
      mergeFieldNames: customFields.map((customField) => customField.name!),
      mergeFields: customFields,
      documents: [
        {
          index: 0,
          name: "purchase-agreement.pdf",
          customFields,
          formFields: metadata().formFields,
        },
      ],
    }));

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

  it("rejects expected merge field names with unknown signer assignment", async () => {
    const customFields = ESIGN_MERGE_FIELD_NAMES.map((name) =>
      field(name, { signer: null, assignedTo: "unknown" }),
    );
    mocks.getTemplate.mockResolvedValue(metadata({
      mergeFields: customFields,
      documents: [
        {
          index: 0,
          name: "purchase-agreement.pdf",
          customFields,
          formFields: metadata().formFields,
        },
      ],
    }));

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

  const ambiguousProviderCases: Array<[string, Partial<ProviderTemplateMetadata>]> = [
    ["missing embedded flag", { isEmbedded: null }],
    ["missing locked flag", { isLocked: null }],
    ["locked provider template", { isLocked: true }],
    ["missing documents", { documents: [], mergeFields: [], formFields: [] }],
    [
      "merge fields assigned to a signer",
      {
        mergeFields: ESIGN_MERGE_FIELD_NAMES.map((name) =>
          field(name, { signer: "1", assignedTo: "signer", signerRoleName: "Seller" }),
        ),
      },
    ],
    [
      "missing Buyer signature",
      { formFields: [metadata().formFields[0]] },
    ],
    [
      "extra required signature for an unsupported signer role",
      {
        formFields: [
          ...metadata().formFields,
          field("agent_signature", {
            apiId: "agent-signature-api",
            type: "signature",
            required: true,
            signer: "Agent",
            assignedTo: "signer",
            signerRoleName: "Agent",
          }),
        ],
      },
    ],
    [
      "required signature with an unknown signer",
      {
        formFields: [
          ...metadata().formFields,
          field("unknown_signature", {
            apiId: "unknown-signature-api",
            type: "signature",
            required: true,
            signer: null,
            assignedTo: "unknown",
            signerRoleName: null,
          }),
        ],
      },
    ],
  ];

  it.each(ambiguousProviderCases)(
    "rejects ambiguous provider readiness: %s",
    async (_name, overrides) => {
      const candidate = metadata(overrides);
      mocks.getTemplate.mockResolvedValue({
        ...candidate,
        documents: overrides.documents ?? [
          {
            index: 0,
            name: "purchase-agreement.pdf",
            customFields: candidate.mergeFields,
            formFields: candidate.formFields,
          },
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
    },
  );

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
