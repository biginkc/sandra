import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  accountGet: vi.fn(),
  apiAppGet: vi.fn(),
  send: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
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
    signatureRequestUpdate = sdk.update;
    signatureRequestList = sdk.list;
    signatureRequestGet = sdk.get;
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
import { HttpError } from "@dropbox/sign";

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
    sdk.update.mockResolvedValue({
      body: {
        signatureRequest: {
          signatures: [
            {
              signatureId: "signature-updated",
              signerRole: "Seller",
              signerName: "Seller",
              signerEmailAddress: "corrected@example.com",
              order: 0,
            },
          ],
        },
      },
    });
  });

  it("preserves the shared Session 03 AbortSignal contract for send, signer update, remind, and cancel", async () => {
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
      testMode: true,
      signers: [{ role: "Seller", name: "Seller", emailAddress: "seller@example.com" }],
      mergeValues: {},
      signal: controller.signal,
    });
    await provider.updateSignerEmail({
      signatureRequestId: "request-1",
      signatureId: "signature-1",
      name: "Seller",
      emailAddress: "corrected@example.com",
      role: "Seller",
      order: 0,
      signal: controller.signal,
    });
    await provider.remind("request-1", { emailAddress: "seller@example.com" }, controller.signal);
    await provider.cancel("request-1", controller.signal);
    expect(sdk.interceptorOptions).toEqual([
      { signal: controller.signal },
      { signal: controller.signal },
      { signal: controller.signal },
      { signal: controller.signal },
    ]);
  });

  it("updates a bounced signer on the existing provider request and returns the new signature id", async () => {
    const provider = createDropboxSignProvider({
      apiKey: new EsignSecret("api-key"),
      clientId: "client-id",
      expectedDomain: "sandra.example.com",
    });

    await expect(
      provider.updateSignerEmail({
        signatureRequestId: "provider-request-1",
        signatureId: "signature-old",
        name: "Seller",
        emailAddress: "corrected@example.com",
        role: "Seller",
        order: 0,
      }),
    ).resolves.toEqual({
      signatureId: "signature-updated",
      role: "Seller",
      name: "Seller",
      emailAddress: "corrected@example.com",
      order: 0,
    });
    expect(sdk.update).toHaveBeenCalledWith("provider-request-1", {
      signatureId: "signature-old",
      emailAddress: "corrected@example.com",
      name: "Seller",
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

  it("returns the authoritative provider and Sandra template identities for reconciliation", async () => {
    sdk.templateGet.mockResolvedValue({ body: { template: {
      templateId: "provider-1",
      title: "Offer",
      metadata: { sandra_template_id: "local-1" },
      isEmbedded: false,
      isLocked: false,
      canEdit: false,
      isCreator: false,
      accounts: [{ accountId: "provider-account-1" }],
      signerRoles: [{ name: "Seller", order: 0 }, { name: "Buyer", order: 1 }],
      documents: [
        {
          name: "purchase-agreement.pdf",
          index: 0,
          customFields: [
            { type: "text", apiId: "seller-name", name: "seller_name", signer: null },
            { type: "text", apiId: "address", name: "property_address", signer: "sender" },
            { type: "text", apiId: "offer", name: "offer_price", signer: null },
            { type: "text", apiId: "closing", name: "closing_date", signer: null },
            { type: "text", apiId: "earnest", name: "earnest_money", signer: null },
          ],
          formFields: [
            { type: "signature", apiId: "seller-signature", name: "Seller signature", signer: "1", required: true },
            { type: "signature", apiId: "buyer-signature", name: "Buyer signature", signer: "2", required: true },
          ],
        },
      ],
      namedFormFields: [{ name: "deprecated_should_not_be_used" }],
    } } });
    const provider = createDropboxSignProvider({ apiKey: new EsignSecret("api-key"), clientId: "client-id", expectedDomain: "sandra.example.com" });
    await expect(provider.getTemplate("provider-1")).resolves.toMatchObject({
      providerTemplateId: "provider-1",
      localTemplateId: "local-1",
      title: "Offer",
      isEmbedded: false,
      canEdit: false,
      isCreator: false,
      isLocked: false,
      signerRoles: [{ name: "Seller", order: 0 }, { name: "Buyer", order: 1 }],
      mergeFieldNames: ["seller_name", "property_address", "offer_price", "closing_date", "earnest_money"],
      mergeFields: [
        expect.objectContaining({ name: "seller_name", assignedTo: "sender", signer: null }),
        expect.objectContaining({ name: "property_address", assignedTo: "sender", signer: "sender" }),
        expect.objectContaining({ name: "offer_price", assignedTo: "sender", signer: null }),
        expect.objectContaining({ name: "closing_date", assignedTo: "sender", signer: null }),
        expect.objectContaining({ name: "earnest_money", assignedTo: "sender", signer: null }),
      ],
      formFields: [
        expect.objectContaining({ type: "signature", signer: "1", signerRoleName: "Seller" }),
        expect.objectContaining({ type: "signature", signer: "2", signerRoleName: "Buyer" }),
      ],
    });
  });

  it("preserves missing custom-field signer as unknown while null and Sender mean Sender", async () => {
    sdk.templateGet.mockResolvedValue({ body: { template: {
      templateId: "provider-1",
      isEmbedded: false,
      isLocked: false,
      signerRoles: [{ name: "Seller", order: 0 }, { name: "Buyer", order: 1 }],
      documents: [
        {
          name: "purchase-agreement.pdf",
          index: 0,
          customFields: [
            { type: "text", apiId: "seller-name", name: "seller_name", signer: null },
            { type: "text", apiId: "sender-case", name: "property_address", signer: "Sender" },
            { type: "text", apiId: "missing-signer", name: "offer_price" },
          ],
          formFields: [],
        },
      ],
    } } });
    const provider = createDropboxSignProvider({
      apiKey: new EsignSecret("api-key"),
      clientId: "client-id",
    });

    await expect(provider.getTemplate("provider-1")).resolves.toMatchObject({
      documents: [
        expect.objectContaining({
          customFields: [
            expect.objectContaining({ name: "seller_name", assignedTo: "sender", signer: null }),
            expect.objectContaining({ name: "property_address", assignedTo: "sender", signer: "Sender" }),
            expect.objectContaining({ name: "offer_price", assignedTo: "unknown", signer: null }),
          ],
        }),
      ],
      mergeFieldNames: ["seller_name", "property_address"],
    });
  });

  it("passes the stored provider account id into accountGet for live quota reads", async () => {
    sdk.accountGet.mockResolvedValue({
      body: {
        account: {
          quotas: { api_signature_requests_left: 17 },
        },
      },
    });
    const provider = createDropboxSignProvider({
      apiKey: new EsignSecret("api-key"),
      clientId: "client-id",
    });
    const controller = new AbortController();

    await expect(
      provider.getRemainingSignatureRequests?.(
        "provider-account-1",
        controller.signal,
      ),
    ).resolves.toBe(17);
    expect(sdk.accountGet).toHaveBeenCalledWith("provider-account-1");
    expect(sdk.interceptorOptions.at(-1)).toEqual({
      signal: controller.signal,
    });
  });

  it("preserves bounded Dropbox rate-limit reset metadata on 429 failures", async () => {
    const error = new HttpError(
      { headers: { "X-Ratelimit-Reset": "1788054300" } } as never,
      {
        error: {
          errorName: "rate_limited",
          errorMsg: "Too many requests",
        },
      } as never,
      429,
    ) as Error & {
      statusCode: number;
      body: { error: { errorName: string; errorMsg: string } };
      response: { headers: Record<string, string> };
    };
    error.statusCode = 429;
    error.body = {
      error: {
        errorName: "rate_limited",
        errorMsg: "Too many requests",
      },
    };
    error.response = {
      headers: {
        "X-Ratelimit-Reset": "1788054300",
      },
    };
    sdk.send.mockRejectedValueOnce(error);
    const provider = createDropboxSignProvider({
      apiKey: new EsignSecret("api-key"),
      clientId: "client-id",
    });

    await expect(
      provider.sendWithTemplate({
        localRequestId: "local-uuid",
        templateId: "provider-template",
        testMode: true,
        signers: [
          {
            role: "Seller",
            name: "Seller",
            emailAddress: "seller@example.com",
          },
        ],
        mergeValues: {},
      }),
    ).rejects.toMatchObject({
      provider: "dropbox_sign",
      details: {
        providerCode: "rate_limited",
        statusCode: 429,
        retryable: true,
        rateLimitResetUnixSeconds: 1788054300,
      },
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
      testMode: true,
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
        false,
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
      "metadata:local-uuid AND test_mode:false AND client_id:client-id",
    );
    expect(sdk.interceptorOptions.at(-1)).toEqual({
      signal: controller.signal,
    });
  });

  it("reads provider-side request metadata for webhook attachment proof", async () => {
    sdk.get.mockResolvedValue({
      body: {
        signatureRequest: {
          signatureRequestId: "provider-request-1",
          metadata: { sandra_request_id: "local-uuid" },
          testMode: true,
        },
      },
    });
    const provider = createDropboxSignProvider({
      apiKey: new EsignSecret("api-key"),
      clientId: "client-id",
      expectedDomain: "sandra.example.com",
    });
    const controller = new AbortController();

    await expect(
      provider.getSignatureRequestMetadata(
        "provider-request-1",
        controller.signal,
      ),
    ).resolves.toEqual({
      signatureRequestId: "provider-request-1",
      localRequestId: "local-uuid",
      testMode: true,
    });
    expect(sdk.get).toHaveBeenCalledWith("provider-request-1");
    expect(sdk.interceptorOptions.at(-1)).toEqual({
      signal: controller.signal,
    });
  });
});
