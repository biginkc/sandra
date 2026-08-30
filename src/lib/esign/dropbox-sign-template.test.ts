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
  class HttpError extends Error {}
  return {
    EmbeddedApi,
    TemplateApi,
    HttpError,
    SubMergeField: { TypeEnum: { Text: "text" } },
  };
});

import { ESIGN_MERGE_FIELD_NAMES } from "./contracts";
import { createDropboxSignTemplateProvider } from "./dropbox-sign-template";
import { EsignSecret } from "./secret";

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
    await provider.createEmbeddedDraft({
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
    const result = await createProvider().getFreshEditUrl("template-1");
    expect(sdk.editUrl).toHaveBeenCalledWith("template-1", {
      forceSignerRoles: true,
      testMode: true,
    });
    expect(sdk.editUrl.mock.calls[0][1]).not.toHaveProperty("mergeFields");
    expect(result.editUrl).toBe("https://edit/2");
  });

  it("requires duplication to return a distinct provider identifier", async () => {
    sdk.updateFiles.mockResolvedValue({ body: { template: { templateId: "template-copy" } } });
    await expect(
      createProvider().duplicateTemplate("template-1", {
        filename: "offer.pdf",
        bytes: Buffer.from("%PDF"),
      }),
    ).resolves.toEqual({ providerTemplateId: "template-copy" });

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
  return createDropboxSignTemplateProvider({
    apiKey: new EsignSecret("api-key"),
    clientId: "client-1",
  });
}
