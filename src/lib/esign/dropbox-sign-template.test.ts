import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  editUrl: vi.fn(),
  get: vi.fn(),
  files: vi.fn(),
  updateFiles: vi.fn(),
  deleteTemplate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@dropbox/sign", () => {
  class BaseApi {
    username?: string;
    password?: string;
  }
  class EmbeddedApi extends BaseApi {
    embeddedEditUrl = sdk.editUrl;
  }
  class TemplateApi extends BaseApi {
    templateCreateEmbeddedDraft = sdk.create;
    templateGet = sdk.get;
    templateFiles = sdk.files;
    templateUpdateFiles = sdk.updateFiles;
    templateDelete = sdk.deleteTemplate;
  }
  class AccountApi extends BaseApi {}
  class ApiAppApi extends BaseApi {}
  class SignatureRequestApi extends BaseApi {}
  class HttpError extends Error {
    constructor(
      public response: { headers?: Record<string, string> },
      public body: unknown,
      public statusCode?: number,
    ) {
      super("HTTP request failed");
    }
  }
  return {
    EmbeddedApi,
    TemplateApi,
    AccountApi,
    ApiAppApi,
    SignatureRequestApi,
    HttpError,
    SubMergeField: { TypeEnum: { Text: "text" } },
  };
});

import { ESIGN_MERGE_FIELD_NAMES } from "./contracts";
import { createDropboxSignProvider } from "./dropbox-sign";
import unfinishedDraftEditUrlError from "./fixtures/dropbox-sign-unfinished-draft-edit-url-error.json";
import { isRestartableDraftEditorFailure } from "./provider-failure";
import { EsignSecret } from "./secret";
import { HttpError } from "@dropbox/sign";

describe("Dropbox Sign template provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.create.mockResolvedValue({
      body: { template: { templateId: "template-1", editUrl: "https://edit/1", expiresAt: 123 } },
    });
    sdk.editUrl.mockResolvedValue({
      body: { embedded: { editUrl: "https://edit/2", expiresAt: 456 } },
    });
  });

  it("creates a test-mode draft with exact ordered roles and merge labels", async () => {
    const provider = createProvider();
    await provider.createEmbeddedTemplateDraft({
      localTemplateId: "local-1",
      title: "Purchase agreement",
      file: { filename: "offer.pdf", bytes: Buffer.from("%PDF") },
      signerRoles: [
        { name: "Seller", order: 0 },
        { name: "Buyer", order: 1 },
      ],
      mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
    });

    expect(sdk.create).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "client-1",
        testMode: true,
        forceSignerRoles: true,
        signerRoles: [
          { name: "Seller", order: 0 },
          { name: "Buyer", order: 1 },
        ],
        mergeFields: ESIGN_MERGE_FIELD_NAMES.map((name) => ({ name, type: "text" })),
      }),
    );
  });

  it("gets a fresh edit URL without resending or clearing merge fields", async () => {
    const result = await createProvider().getEmbeddedTemplateEditUrl("template-1");
    expect(sdk.editUrl).toHaveBeenCalledWith("template-1", {
      forceSignerRoles: true,
      testMode: true,
    });
    expect(sdk.editUrl.mock.calls[0][1]).not.toHaveProperty("mergeFields");
    expect(result.editUrl).toBe("https://edit/2");
  });

  it("normalizes the captured SDK error into the restart classifier", async () => {
    const fixture = unfinishedDraftEditUrlError.preflightResponse;
    sdk.get.mockRejectedValueOnce(
      new HttpError(
        { headers: {} } as never,
        {
          error: {
            errorName: fixture.errorName,
            errorMsg: fixture.errorMsg,
            errorPath: fixture.errorPath,
          },
        } as never,
        fixture.statusCode,
      ),
    );

    const error = await createProvider()
      .getTemplate("template-1")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      details: {
        statusCode: fixture.statusCode,
        providerCode: fixture.normalizedProviderCode,
        retryable: false,
      },
    });
    expect(isRestartableDraftEditorFailure(error)).toBe(true);
  });

  it("requires duplication to return a distinct provider identifier", async () => {
    sdk.updateFiles.mockResolvedValue({ body: { template: { templateId: "template-copy" } } });
    await expect(
      createProvider().duplicateTemplate("template-1", {
        filename: "offer.pdf",
        bytes: Buffer.from("%PDF"),
      }),
    ).resolves.toEqual({ providerTemplateId: "template-copy", readiness: "pending" });

    sdk.updateFiles.mockResolvedValue({ body: { template: { templateId: "template-1" } } });
    await expect(
      createProvider().duplicateTemplate("template-1", {
        filename: "offer.pdf",
        bytes: Buffer.from("%PDF"),
      }),
    ).rejects.toThrow(/distinct copied template identifier/i);
  });
});

function createProvider() {
  return createDropboxSignProvider({
    apiKey: new EsignSecret("api-key"),
    clientId: "client-1",
    expectedDomain: "sandra.example.com",
  });
}
