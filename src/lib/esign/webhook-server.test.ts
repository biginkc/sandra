import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createConcreteDropboxSignWebhookDependencies } from "./webhook-server";

const serverMocks = vi.hoisted(() => ({
  getEsignCredentials: vi.fn(),
  createDropboxSignProvider: vi.fn(),
}));

vi.mock("./credentials", () => ({
  configuredDropboxSignEmbeddedDomain: vi.fn(() => "sandra.test"),
  getEsignCredentials: serverMocks.getEsignCredentials,
}));

vi.mock("./dropbox-sign", () => ({
  createDropboxSignProvider: serverMocks.createDropboxSignProvider,
}));

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONSUMER_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";
const LEASE_ID = "55555555-5555-4555-8555-555555555555";

type AdminClient = SupabaseClient<Database>;

function queryResult<T>(data: T) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    is: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  return query;
}

describe("concrete eSign webhook server binding", () => {
  it("resolves a secret only when the active integration owns that consumer", async () => {
    const consumerQuery = queryResult({ id: CONSUMER_ID, org_id: ORG_ID });
    const integrationQuery = queryResult({ org_id: ORG_ID });
    const client = {
      from: vi.fn((table: string) =>
        table === "webhook_consumers" ? consumerQuery : integrationQuery,
      ),
      rpc: vi.fn(),
      storage: { from: vi.fn() },
    } as unknown as AdminClient;
    const dependencies = createConcreteDropboxSignWebhookDependencies(client);

    await expect(
      dependencies.secretResolver.resolvePathSecretHash("a".repeat(64)),
    ).resolves.toEqual({ orgId: ORG_ID, callbackConsumerId: CONSUMER_ID });
    expect(consumerQuery.eq).toHaveBeenCalledWith(
      "consumer_type",
      "esign_provider",
    );
    expect(consumerQuery.eq).toHaveBeenCalledWith("enabled", true);
    expect(consumerQuery.is).toHaveBeenCalledWith("revoked_at", null);
    expect(integrationQuery.eq).toHaveBeenCalledWith(
      "callback_consumer_id",
      CONSUMER_ID,
    );
  });

  it("fails closed when the consumer is not the integration's current generation", async () => {
    const consumerQuery = queryResult({ id: CONSUMER_ID, org_id: ORG_ID });
    const integrationQuery = queryResult(null);
    const client = {
      from: vi.fn((table: string) =>
        table === "webhook_consumers" ? consumerQuery : integrationQuery,
      ),
      rpc: vi.fn(),
      storage: { from: vi.fn() },
    } as unknown as AdminClient;

    await expect(
      createConcreteDropboxSignWebhookDependencies(
        client,
      ).secretResolver.resolvePathSecretHash("a".repeat(64)),
    ).resolves.toBeNull();
  });

  it.each(["revoked", "disabled", "wrong-type"])(
    "does not load HMAC credentials when the consumer becomes %s after secret resolution",
    async () => {
      serverMocks.getEsignCredentials.mockClear();
      const initialConsumer = queryResult({ id: CONSUMER_ID, org_id: ORG_ID });
      const activeConsumer = queryResult({ id: CONSUMER_ID, org_id: ORG_ID });
      const inactiveConsumer = queryResult(null);
      const integration = queryResult({ org_id: ORG_ID });
      const from = vi.fn()
        .mockReturnValueOnce(initialConsumer)
        .mockReturnValueOnce(integration)
        .mockReturnValueOnce(activeConsumer)
        .mockReturnValueOnce(integration)
        .mockReturnValueOnce(inactiveConsumer);
      const client = {
        from,
        rpc: vi.fn(),
        storage: { from: vi.fn() },
      } as unknown as AdminClient;
      const dependencies = createConcreteDropboxSignWebhookDependencies(client);

      const identity = await dependencies.secretResolver.resolvePathSecretHash("a".repeat(64));
      expect(identity).toEqual({ orgId: ORG_ID, callbackConsumerId: CONSUMER_ID });
      await expect(dependencies.authenticator.verifyForIntegration({
        ...identity!,
        replay: {
          payloadHash: "a".repeat(64),
          eventHash: "0".repeat(64),
          eventTime: "1788054000",
	          eventType: "signature_request_viewed",
	          signRequestId: "provider-request-1",
	          localRequestId: null,
	          relatedSignatureId: null,
          reportedForAppId: null,
          providerSignatures: [],
        },
      })).resolves.toBe(false);
      expect(serverMocks.getEsignCredentials).not.toHaveBeenCalled();
      expect(inactiveConsumer.eq).toHaveBeenCalledWith("consumer_type", "esign_provider");
      expect(inactiveConsumer.eq).toHaveBeenCalledWith("enabled", true);
      expect(inactiveConsumer.is).toHaveBeenCalledWith("revoked_at", null);
    },
  );

  it("does not create a provider client when the consumer is revoked after receipt claim", async () => {
    serverMocks.getEsignCredentials.mockClear();
    serverMocks.createDropboxSignProvider.mockClear();
    const inactiveConsumer = queryResult(null);
    const integration = queryResult({ org_id: ORG_ID });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(integration)
        .mockReturnValueOnce(inactiveConsumer),
      rpc: vi.fn(),
      storage: { from: vi.fn() },
    } as unknown as AdminClient;
    const dependencies = createConcreteDropboxSignWebhookDependencies(client);

    await expect(dependencies.pdfProvider.downloadSignedPdf({
      orgId: ORG_ID,
      callbackConsumerId: CONSUMER_ID,
      signRequestId: "provider-request-1",
    })).rejects.toThrow("The eSign webhook server operation failed.");
    expect(serverMocks.getEsignCredentials).not.toHaveBeenCalled();
    expect(serverMocks.createDropboxSignProvider).not.toHaveBeenCalled();
  });

  it("attaches a stranded webhook request only when Dropbox metadata proves mode truth", async () => {
    serverMocks.getEsignCredentials.mockClear();
    serverMocks.createDropboxSignProvider.mockClear();
    serverMocks.getEsignCredentials.mockResolvedValue({
      apiKey: { reveal: () => "dropbox-api-key" },
      clientId: "client-1",
    });
    const activeConsumer = queryResult({ id: CONSUMER_ID, org_id: ORG_ID });
    const integration = queryResult({ org_id: ORG_ID });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(integration)
        .mockReturnValueOnce(activeConsumer)
        .mockReturnValueOnce(integration)
        .mockReturnValueOnce(activeConsumer),
      rpc: vi.fn(),
      storage: { from: vi.fn() },
    } as unknown as AdminClient;
    const provider = {
      getSignatureRequestMetadata: vi.fn()
        .mockResolvedValueOnce({
          signatureRequestId: "provider-request-1",
          localRequestId: REQUEST_ID,
          testMode: false,
        })
        .mockResolvedValueOnce({
          signatureRequestId: "provider-request-1",
          localRequestId: REQUEST_ID,
          testMode: true,
        }),
    };
    serverMocks.createDropboxSignProvider.mockReturnValue(provider);
    const dependencies = createConcreteDropboxSignWebhookDependencies(client);

    await expect(dependencies.metadataProvider.confirmProviderLocalRequestId({
      orgId: ORG_ID,
      callbackConsumerId: CONSUMER_ID,
      signRequestId: "provider-request-1",
      localRequestId: REQUEST_ID,
      testMode: true,
    })).resolves.toBe("mismatch");
    await expect(dependencies.metadataProvider.confirmProviderLocalRequestId({
      orgId: ORG_ID,
      callbackConsumerId: CONSUMER_ID,
      signRequestId: "provider-request-1",
      localRequestId: REQUEST_ID,
      testMode: true,
    })).resolves.toBe("matched");
  });

  it("accepts omitted provider mode after Dropbox metadata proves the Sandra local request id", async () => {
    serverMocks.getEsignCredentials.mockClear();
    serverMocks.createDropboxSignProvider.mockClear();
    serverMocks.getEsignCredentials.mockResolvedValue({
      apiKey: { reveal: () => "dropbox-api-key" },
      clientId: "client-1",
    });
    const activeConsumer = queryResult({ id: CONSUMER_ID, org_id: ORG_ID });
    const integration = queryResult({ org_id: ORG_ID });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(integration)
        .mockReturnValueOnce(activeConsumer)
        .mockReturnValueOnce(integration)
        .mockReturnValueOnce(activeConsumer),
      rpc: vi.fn(),
      storage: { from: vi.fn() },
    } as unknown as AdminClient;
    const provider = {
      getSignatureRequestMetadata: vi.fn()
        .mockResolvedValueOnce({
          signatureRequestId: "provider-request-1",
          localRequestId: REQUEST_ID,
          testMode: false,
        })
        .mockResolvedValueOnce({
          signatureRequestId: "provider-request-1",
          localRequestId: REQUEST_ID,
          testMode: null,
        }),
    };
    serverMocks.createDropboxSignProvider.mockReturnValue(provider);
    const dependencies = createConcreteDropboxSignWebhookDependencies(client);

    await expect(dependencies.metadataProvider.confirmProviderLocalRequestId({
      orgId: ORG_ID,
      callbackConsumerId: CONSUMER_ID,
      signRequestId: "provider-request-1",
      localRequestId: REQUEST_ID,
      testMode: null,
    })).resolves.toBe("matched");
    await expect(dependencies.metadataProvider.confirmProviderLocalRequestId({
      orgId: ORG_ID,
      callbackConsumerId: CONSUMER_ID,
      signRequestId: "provider-request-1",
      localRequestId: REQUEST_ID,
      testMode: null,
    })).resolves.toBe("matched");
  });

  it("treats an existing opaque PDF object as retry convergence, then links atomically", async () => {
    const upload = vi.fn(async () => ({
      data: null,
      error: { statusCode: "409", message: "private@example.com" },
    }));
    const rpc = vi.fn(async (name: string) => ({
      data:
        name === "link_esign_signed_artifact"
          ? [{ outcome: "already_linked", lead_file_id: RECEIPT_ID }]
          : null,
      error: null,
    }));
    const client = {
      from: vi.fn(),
      rpc,
      storage: { from: vi.fn(() => ({ upload })) },
    } as unknown as AdminClient;
    const dependencies = createConcreteDropboxSignWebhookDependencies(client);
    const pdf = Buffer.from("%PDF-1.7\nsigned");
    const storagePath = `${ORG_ID}/${REQUEST_ID}/${RECEIPT_ID}.pdf`;

    await expect(
      dependencies.artifactPersistence.storeLinkAndRecordReady({
        orgId: ORG_ID,
        propertyId: "66666666-6666-4666-8666-666666666666",
        requestId: REQUEST_ID,
        claim: {
          outcome: "claimed",
          receiptId: RECEIPT_ID,
          leaseId: LEASE_ID,
        },
        templateTitle: "Purchase Agreement",
        pdf,
        artifact: {
          storageBucket: "lead-files",
          storagePath,
          fileName: "signed-contract.pdf",
          contentType: "application/pdf",
          sizeBytes: pdf.byteLength,
        },
      }),
    ).resolves.toEqual({ outcome: "already_linked", leadFileId: RECEIPT_ID });
    expect(upload).toHaveBeenCalledWith(storagePath, pdf, {
      contentType: "application/pdf",
      upsert: false,
    });
    expect(rpc).toHaveBeenCalledWith(
      "link_esign_signed_artifact",
      expect.objectContaining({
        p_org_id: ORG_ID,
        p_request_id: REQUEST_ID,
        p_receipt_id: RECEIPT_ID,
        p_lease_id: LEASE_ID,
        p_lead_file_id: RECEIPT_ID,
      }),
    );
  });

  it("returns a PII-safe failure without linking when private upload fails", async () => {
    const privateError = "private-seller@example.com";
    const rpc = vi.fn();
    const client = {
      from: vi.fn(),
      rpc,
      storage: {
        from: vi.fn(() => ({
          upload: vi.fn(async () => ({
            data: null,
            error: { statusCode: 500, message: privateError },
          })),
        })),
      },
    } as unknown as AdminClient;
    const dependencies = createConcreteDropboxSignWebhookDependencies(client);

    let caught: unknown;
    try {
      await dependencies.artifactPersistence.storeLinkAndRecordReady({
        orgId: ORG_ID,
        propertyId: "66666666-6666-4666-8666-666666666666",
        requestId: REQUEST_ID,
        claim: {
          outcome: "claimed",
          receiptId: RECEIPT_ID,
          leaseId: LEASE_ID,
        },
        templateTitle: "Purchase Agreement",
        pdf: Buffer.from("%PDF-1.7"),
        artifact: {
          storageBucket: "lead-files",
          storagePath: `${ORG_ID}/${REQUEST_ID}/${RECEIPT_ID}.pdf`,
          fileName: "signed-contract.pdf",
          contentType: "application/pdf",
          sizeBytes: 8,
        },
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).not.toContain(privateError);
    expect(rpc).not.toHaveBeenCalled();
  });
});
