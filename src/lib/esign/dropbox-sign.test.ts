import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  accountGet: vi.fn(),
  apiAppGet: vi.fn(),
  send: vi.fn(),
  signUrl: vi.fn(),
  remind: vi.fn(),
  cancel: vi.fn(),
  files: vi.fn(),
  credentials: [] as Array<{ username?: string; password?: string }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@dropbox/sign", () => {
  class BaseApi {
    username?: string;
    password?: string;

    constructor() {
      sdk.credentials.push(this);
    }
  }
  class AccountApi extends BaseApi {
    accountGet = sdk.accountGet;
  }
  class ApiAppApi extends BaseApi {
    apiAppGet = sdk.apiAppGet;
  }
  class EmbeddedApi extends BaseApi {
    embeddedEditUrl = sdk.signUrl;
  }
  class SignatureRequestApi extends BaseApi {
    signatureRequestSendWithTemplate = sdk.send;
    signatureRequestRemind = sdk.remind;
    signatureRequestCancel = sdk.cancel;
    signatureRequestFiles = sdk.files;
  }
  class TemplateApi extends BaseApi {}
  class HttpError extends Error {}
  return {
    AccountApi,
    ApiAppApi,
    EmbeddedApi,
    SignatureRequestApi,
    TemplateApi,
    HttpError,
  };
});

import { createDropboxSignProvider } from "./dropbox-sign";
import { EsignSecret } from "./secret";

describe("Dropbox Sign provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.credentials.length = 0;
    sdk.accountGet.mockResolvedValue({
      body: { account: { accountId: "account-1" } },
    });
    sdk.apiAppGet.mockResolvedValue({
      body: {
        apiApp: {
          clientId: "client-id",
          domains: ["sandra.example.com"],
        },
      },
    });
    sdk.send.mockResolvedValue({
      body: {
        signatureRequest: {
          signatureRequestId: "provider-request-1",
          detailsUrl: "https://app.hellosign.com/home/manage",
          signatures: [
            {
              signatureId: "signature-1",
              signerRole: "Seller",
              signerName: "Seller",
              signerEmailAddress: "seller@example.com",
              order: 0,
            },
          ],
        },
      },
    });
  });

  it("authenticates the official SDK with API-key basic auth", async () => {
    const provider = createDropboxSignProvider({
      apiKey: new EsignSecret("api-key"),
      clientId: "client-id",
      expectedDomain: "sandra.example.com",
    });
    await expect(provider.validateCredentials()).resolves.toEqual({
      accountId: "account-1",
      clientId: "client-id",
      domains: ["sandra.example.com"],
    });
    expect(sdk.credentials).toHaveLength(5);
    expect(sdk.credentials).toEqual([
      expect.objectContaining({ username: "api-key", password: "" }),
      expect.objectContaining({ username: "api-key", password: "" }),
      expect.objectContaining({ username: "api-key", password: "" }),
      expect.objectContaining({ username: "api-key", password: "" }),
      expect.objectContaining({ username: "api-key", password: "" }),
    ]);
  });

  it("forces test mode and preserves local/provider identifiers separately", async () => {
    const provider = createDropboxSignProvider({
      apiKey: new EsignSecret("api-key"),
      clientId: "client-id",
      expectedDomain: "sandra.example.com",
    });
    const result = await provider.sendWithTemplate({
      localRequestId: "local-uuid",
      templateId: "provider-template",
      signers: [
        {
          role: "Seller",
          name: "Seller",
          emailAddress: "seller@example.com",
        },
      ],
      mergeValues: { "Purchase price": "100000" },
    });

    expect(sdk.send).toHaveBeenCalledWith(
      expect.objectContaining({
        templateIds: ["provider-template"],
        clientId: "client-id",
        testMode: true,
        metadata: { sandra_request_id: "local-uuid" },
      }),
    );
    expect(result).toEqual({
      signatureRequestId: "provider-request-1",
      signatures: [
        {
          signatureId: "signature-1",
          role: "Seller",
          name: "Seller",
          emailAddress: "seller@example.com",
          order: 0,
        },
      ],
      detailsUrl: "https://app.hellosign.com/home/manage",
      testMode: true,
    });
    expect(result).not.toHaveProperty("signingUrl");
  });
});
