import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  accountGet: vi.fn(),
  apiAppGet: vi.fn(),
  send: vi.fn(),
  list: vi.fn(),
  signUrl: vi.fn(),
  remind: vi.fn(),
  cancel: vi.fn(),
  files: vi.fn(),
  templateGet: vi.fn(),
  interceptorOptions: [] as Array<{ signal?: AbortSignal }>,
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

    addInterceptor(interceptor: (options: { signal?: AbortSignal }) => void) {
      const options: { signal?: AbortSignal } = {};
      interceptor(options);
      sdk.interceptorOptions.push(options);
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
    signatureRequestList = sdk.list;
    signatureRequestRemind = sdk.remind;
    signatureRequestCancel = sdk.cancel;
    signatureRequestFiles = sdk.files;
  }
  class TemplateApi extends BaseApi { templateGet = sdk.templateGet; }
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
    sdk.interceptorOptions.length = 0;
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

  it("preserves the shared Session 03 AbortSignal contract for send, remind, and cancel", async () => {
    sdk.remind.mockResolvedValue({ body: {} });
    sdk.cancel.mockResolvedValue({ body: {} });
    const provider = createDropboxSignProvider({
      apiKey: new EsignSecret("api-key"),
      clientId: "client-id",
      expectedDomain: "sandra.example.com",
    });
    const controller = new AbortController();
    await provider.sendWithTemplate({
      localRequestId: "local-uuid",
      templateId: "provider-template",
      signers: [{ role: "Seller", name: "Seller", emailAddress: "seller@example.com" }],
      mergeValues: {},
      signal: controller.signal,
    });
    await provider.remind("request-1", { emailAddress: "seller@example.com" }, controller.signal);
    await provider.cancel("request-1", controller.signal);
    expect(sdk.interceptorOptions).toEqual([
      { signal: controller.signal },
      { signal: controller.signal },
      { signal: controller.signal },
    ]);
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

  it("returns the authoritative provider and Sandra template identities for reconciliation", async () => {
    sdk.templateGet.mockResolvedValue({ body: { template: {
      templateId: "provider-1",
      title: "Offer",
      metadata: { sandra_template_id: "local-1" },
      signerRoles: [{ name: "Seller", order: 0 }],
      namedFormFields: [{ name: "seller_name" }, { name: "property_address" }, { name: "offer_price" }, { name: "closing_date" }, { name: "earnest_money" }],
    } } });
    const provider = createDropboxSignProvider({ apiKey: new EsignSecret("api-key"), clientId: "client-id", expectedDomain: "sandra.example.com" });
    await expect(provider.getTemplate("provider-1")).resolves.toMatchObject({
      providerTemplateId: "provider-1",
      localTemplateId: "local-1",
      title: "Offer",
      signerRoles: [{ name: "Seller", order: 0 }],
    });
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

  it("performs a bounded exact-metadata lookup before stale-send recovery", async () => {
    sdk.list.mockResolvedValue({
      body: {
        signatureRequests: [
          {
            signatureRequestId: "provider-request-1",
            metadata: { sandra_request_id: "local-uuid" },
          },
          {
            signatureRequestId: "false-positive",
            metadata: { sandra_request_id: "other" },
          },
        ],
        listInfo: { numPages: 1, numResults: 2, page: 1, pageSize: 100 },
      },
    });
    const provider = createDropboxSignProvider({
      apiKey: new EsignSecret("api-key"),
      clientId: "client-id",
      expectedDomain: "sandra.example.com",
    });
    const controller = new AbortController();

    await expect(
      provider.findSignatureRequestIdsByLocalRequestId(
        "local-uuid",
        controller.signal,
      ),
    ).resolves.toEqual({
      complete: true,
      providerRequestIds: ["provider-request-1"],
    });
    expect(sdk.list).toHaveBeenCalledWith(
      undefined,
      1,
      100,
      "metadata:local-uuid AND test_mode:true AND client_id:client-id",
    );
    expect(sdk.interceptorOptions.at(-1)).toEqual({
      signal: controller.signal,
    });
  });
});
