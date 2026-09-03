import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { EsignWebhookDependencies } from "./ports";
import { EsignSecret } from "./secret";
import {
  DROPBOX_SIGN_ACKNOWLEDGEMENT,
  createDropboxSignEventAuthenticator,
  handleDropboxSignWebhook,
} from "./webhook-handler";

const PATH_SECRET = "a".repeat(43);
const API_KEY = "dropbox-test-api-key";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROPERTY_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const CONSUMER_ID = "44444444-4444-4444-8444-444444444444";
const CLAIM = {
  outcome: "claimed" as const,
  receiptId: "receipt-1",
  leaseId: "lease-1",
};

function callbackRequest(input: {
  eventType?: string;
  eventHash?: string;
  signRequestId?: string | null;
  localRequestId?: string | null;
  testMode?: boolean;
  relatedSignatureId?: string | null;
  providerSignatures?: Array<{
    signature_id: string;
    signer_role: string;
    signer_name: string;
    signer_email_address: string;
    order: number;
    status_code?: string;
    signed_at?: number;
  }>;
} = {}): Request {
  const eventTime = "1788054000";
  const eventType = input.eventType ?? "signature_request_viewed";
  const eventHash =
    input.eventHash ??
    createHmac("sha256", API_KEY).update(eventTime + eventType).digest("hex");
  const form = new FormData();
  form.set(
    "json",
    JSON.stringify({
      event: {
        event_time: eventTime,
        event_type: eventType,
        event_hash: eventHash,
        event_metadata: {
          ...(input.relatedSignatureId === null
            ? {}
            : {
                related_signature_id:
                  input.relatedSignatureId ?? "provider-signature-1",
              }),
          reported_for_app_id: "client-1",
        },
      },
      ...(input.signRequestId === null
        ? {}
        : {
            signature_request: {
              signature_request_id:
                input.signRequestId ?? "provider-request-1",
              metadata: {
                sandra_request_id: input.localRequestId ?? REQUEST_ID,
              },
              ...(input.testMode === undefined ? {} : { test_mode: input.testMode }),
              signatures: input.providerSignatures ?? [],
            },
          }),
    }),
  );
  return new Request("https://sandra.test/api/webhooks/esign/secret", {
    method: "POST",
    body: form,
  });
}

function dependencies(
  overrides: Partial<EsignWebhookDependencies> = {},
): EsignWebhookDependencies {
  const persistence: EsignWebhookDependencies["persistence"] = {
    claimVerifiedReceipt: vi.fn(async () => ({
      ...CLAIM,
    })),
    findRequest: vi.fn(async () => ({
      id: REQUEST_ID,
      orgId: ORG_ID,
      propertyId: PROPERTY_ID,
      status: "awaiting" as const,
      testMode: true,
      signedPdfPath: null,
      templateTitle: "Purchase Agreement",
    })),
    applyStatusDecision: vi.fn(async ({ decision }) => ({
      outcome: "applied" as const,
      status: decision.nextStatus,
    })),
    applyEmailBounceDecision: vi.fn(async () => ({
      outcome: "applied" as const,
      status: "error" as const,
    })),
    reconcileReminderCallback: vi.fn(async () => "applied" as const),
    reconcileProviderSigners: vi.fn(async () => "applied" as const),
    markReceiptProcessed: vi.fn(async () => undefined),
    markReceiptIgnored: vi.fn(async () => undefined),
    markReceiptFailed: vi.fn(async () => undefined),
  };
  return {
    secretResolver: {
      resolvePathSecretHash: vi.fn(async () => ({
        orgId: ORG_ID,
        callbackConsumerId: CONSUMER_ID,
      })),
    },
    authenticator: createDropboxSignEventAuthenticator({
      loadCredentials: vi.fn(async () => ({
        apiKey: new EsignSecret(API_KEY),
        clientId: "client-1",
      })),
    }),
    persistence,
    metadataProvider: {
      confirmProviderLocalRequestId: vi.fn(async ({ localRequestId }) =>
        localRequestId === REQUEST_ID ? "matched" : "mismatch",
      ),
    },
    pdfProvider: {
      downloadSignedPdf: vi.fn(async () => Buffer.from("%PDF-1.7\nsigned")),
    },
    artifactPersistence: {
      storeLinkAndRecordReady: vi.fn(async () => ({
        outcome: "applied" as const,
        leadFileId: "lead-file-1",
      })),
    },
    ...overrides,
  };
}

describe("injectable Dropbox Sign webhook handler", () => {
  it("applies a verified transition and returns the exact acknowledgement", async () => {
    const deps = dependencies();
    const response = await handleDropboxSignWebhook({
      request: callbackRequest(),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(DROPBOX_SIGN_ACKNOWLEDGEMENT);
    expect(deps.persistence.findRequest).toHaveBeenCalledWith({
      orgId: ORG_ID,
      signRequestId: "provider-request-1",
      verifiedLocalRequestId: null,
    });
    expect(deps.persistence.applyStatusDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        requestId: REQUEST_ID,
        propertyId: PROPERTY_ID,
        claim: CLAIM,
        decision: expect.objectContaining({
          previousStatus: "awaiting",
          nextStatus: "viewed",
          changed: true,
        }),
      }),
    );
    expect(deps.persistence.markReceiptProcessed).toHaveBeenCalledWith(CLAIM);
  });

  it("applies email-bounce delivery truth without the generic provider-error transition", async () => {
    const deps = dependencies();
    const response = await handleDropboxSignWebhook({
      request: callbackRequest({
        eventType: "signature_request_email_bounce",
        providerSignatures: [{
          signature_id: "provider-signature-1",
          signer_role: "Seller",
          signer_name: "Seller Owner",
          signer_email_address: "bad@example.invalid",
          order: 0,
        }],
      }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(deps.persistence.applyEmailBounceDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        requestId: REQUEST_ID,
        claim: CLAIM,
        decision: expect.objectContaining({
          previousStatus: "awaiting",
          nextStatus: "error",
          reason: "email_bounced",
        }),
      }),
    );
    expect(deps.persistence.applyStatusDecision).not.toHaveBeenCalled();
    expect(deps.persistence.reconcileProviderSigners).not.toHaveBeenCalled();
    expect(deps.persistence.markReceiptProcessed).toHaveBeenCalledWith(CLAIM);
  });

  it("keeps a bounce callback retryable when code reaches a pre-bounce-RPC database", async () => {
    const deps = dependencies();
    vi.mocked(deps.persistence.applyEmailBounceDecision).mockResolvedValue(null);

    const response = await handleDropboxSignWebhook({
      request: callbackRequest({
        eventType: "signature_request_email_bounce",
        providerSignatures: [{
          signature_id: "provider-signature-1",
          signer_role: "Seller",
          signer_name: "Seller Owner",
          signer_email_address: "bad@example.invalid",
          order: 0,
        }],
      }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(503);
    expect(deps.persistence.applyEmailBounceDecision).toHaveBeenCalled();
    expect(deps.persistence.applyStatusDecision).not.toHaveBeenCalled();
    expect(deps.persistence.markReceiptProcessed).not.toHaveBeenCalled();
    expect(deps.persistence.markReceiptFailed).toHaveBeenCalledWith(
      CLAIM,
      "EMAIL_BOUNCE_RPC_UNAVAILABLE",
    );
  });

  it("continues normal webhook processing after provider-read metadata repairs a timeout-stranded send", async () => {
    const deps = dependencies();
    vi.mocked(deps.persistence.findRequest)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: REQUEST_ID,
        orgId: ORG_ID,
        propertyId: PROPERTY_ID,
        status: "awaiting" as const,
        testMode: true,
        signedPdfPath: null,
        templateTitle: "Purchase Agreement",
      });

    const response = await handleDropboxSignWebhook({
      request: callbackRequest({
        signRequestId: "provider-after-timeout",
        testMode: true,
      }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(deps.metadataProvider.confirmProviderLocalRequestId).toHaveBeenCalledWith({
      orgId: ORG_ID,
      callbackConsumerId: CONSUMER_ID,
      signRequestId: "provider-after-timeout",
      localRequestId: REQUEST_ID,
      testMode: true,
    });
    expect(deps.persistence.findRequest).toHaveBeenNthCalledWith(1, {
      orgId: ORG_ID,
      signRequestId: "provider-after-timeout",
      verifiedLocalRequestId: null,
    });
    expect(deps.persistence.findRequest).toHaveBeenNthCalledWith(2, {
      orgId: ORG_ID,
      signRequestId: "provider-after-timeout",
      verifiedLocalRequestId: REQUEST_ID,
    });
    expect(deps.persistence.applyStatusDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: REQUEST_ID,
        decision: expect.objectContaining({ nextStatus: "viewed" }),
      }),
    );
    expect(deps.persistence.markReceiptProcessed).toHaveBeenCalledWith(CLAIM);
  });

  it("uses Sandra-stored mode for an official callback without test_mode when the provider request is already attached", async () => {
    const deps = dependencies();

    const response = await handleDropboxSignWebhook({
      request: callbackRequest({
        signRequestId: "provider-request-1",
      }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(deps.persistence.findRequest).toHaveBeenCalledWith({
      orgId: ORG_ID,
      signRequestId: "provider-request-1",
      verifiedLocalRequestId: null,
    });
    expect(deps.metadataProvider.confirmProviderLocalRequestId).not.toHaveBeenCalled();
    expect(deps.persistence.markReceiptIgnored).not.toHaveBeenCalledWith(
      CLAIM,
      "REQUEST_MODE_MISMATCH",
    );
    expect(deps.persistence.applyStatusDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: REQUEST_ID,
        decision: expect.objectContaining({ nextStatus: "viewed" }),
      }),
    );
    expect(deps.persistence.markReceiptProcessed).toHaveBeenCalledWith(CLAIM);
  });

  it("rejects spoofed body metadata when provider-side metadata does not match", async () => {
    const deps = dependencies();
    vi.mocked(deps.persistence.findRequest).mockResolvedValue(null);

    const response = await handleDropboxSignWebhook({
      request: callbackRequest({
        signRequestId: "provider-after-timeout",
        localRequestId: "spoofed-local-request",
        testMode: true,
      }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(DROPBOX_SIGN_ACKNOWLEDGEMENT);
    expect(deps.metadataProvider.confirmProviderLocalRequestId).toHaveBeenCalledWith({
      orgId: ORG_ID,
      callbackConsumerId: CONSUMER_ID,
      signRequestId: "provider-after-timeout",
      localRequestId: "spoofed-local-request",
      testMode: true,
    });
    expect(deps.persistence.findRequest).toHaveBeenCalledTimes(1);
    expect(deps.persistence.markReceiptIgnored).toHaveBeenCalledWith(
      CLAIM,
      "PROVIDER_METADATA_MISMATCH",
    );
    expect(deps.persistence.applyStatusDecision).not.toHaveBeenCalled();
  });

  it("uses authenticated provider metadata to recover an official callback without test_mode", async () => {
    const deps = dependencies();
    vi.mocked(deps.persistence.findRequest)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: REQUEST_ID,
        orgId: ORG_ID,
        propertyId: PROPERTY_ID,
        status: "awaiting" as const,
        testMode: true,
        signedPdfPath: null,
        templateTitle: "Purchase Agreement",
      });

    const response = await handleDropboxSignWebhook({
      request: callbackRequest({
        signRequestId: "provider-after-timeout",
        localRequestId: REQUEST_ID,
      }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(deps.metadataProvider.confirmProviderLocalRequestId).toHaveBeenCalledWith({
      orgId: ORG_ID,
      callbackConsumerId: CONSUMER_ID,
      signRequestId: "provider-after-timeout",
      localRequestId: REQUEST_ID,
      testMode: null,
    });
    expect(deps.persistence.findRequest).toHaveBeenNthCalledWith(2, {
      orgId: ORG_ID,
      signRequestId: "provider-after-timeout",
      verifiedLocalRequestId: REQUEST_ID,
    });
    expect(deps.persistence.markReceiptIgnored).not.toHaveBeenCalledWith(
      CLAIM,
      "CALLBACK_MODE_MISSING",
    );
    expect(deps.persistence.markReceiptProcessed).toHaveBeenCalledWith(CLAIM);
  });

  it("keeps a metadata-repaired callback retryable when provider mode cannot be proven", async () => {
    const deps = dependencies();
    vi.mocked(deps.persistence.findRequest).mockResolvedValue(null);
    vi.mocked(deps.metadataProvider.confirmProviderLocalRequestId)
      .mockResolvedValue("mode_unverified");

    const response = await handleDropboxSignWebhook({
      request: callbackRequest({
        signRequestId: "provider-after-timeout",
        localRequestId: REQUEST_ID,
      }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(503);
    expect(deps.persistence.markReceiptIgnored).not.toHaveBeenCalled();
    expect(deps.persistence.markReceiptFailed).toHaveBeenCalledWith(
      CLAIM,
      "PROVIDER_MODE_UNVERIFIED",
    );
  });

  it("rejects an invalid event hash before claiming a receipt", async () => {
    const deps = dependencies();
    const response = await handleDropboxSignWebhook({
      request: callbackRequest({ eventHash: "0".repeat(64) }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(403);
    expect(deps.persistence.claimVerifiedReceipt).not.toHaveBeenCalled();
  });

  it("acknowledges an already-processed composite receipt without replaying it", async () => {
    const deps = dependencies();
    vi.mocked(deps.persistence.claimVerifiedReceipt).mockResolvedValue({
      outcome: "already_processed",
      receiptId: "receipt-1",
    });
    const response = await handleDropboxSignWebhook({
      request: callbackRequest(),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(DROPBOX_SIGN_ACKNOWLEDGEMENT);
    expect(deps.persistence.findRequest).not.toHaveBeenCalled();
  });

  it("preserves per-signer signed as an ignored audit receipt", async () => {
    const deps = dependencies();
    const response = await handleDropboxSignWebhook({
      request: callbackRequest({ eventType: "signature_request_signed" }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(deps.persistence.applyStatusDecision).not.toHaveBeenCalled();
    expect(deps.persistence.reconcileProviderSigners).toHaveBeenCalledWith({
      orgId: ORG_ID,
      requestId: REQUEST_ID,
      claim: CLAIM,
      providerEventAt: new Date("2026-08-30T01:40:00.000Z"),
      providerSignatures: [],
      signedProviderSignatureId: "provider-signature-1",
    });
    expect(deps.persistence.markReceiptProcessed).toHaveBeenCalledWith(CLAIM);
    expect(deps.persistence.markReceiptIgnored).not.toHaveBeenCalled();
  });

  it("reconciles the provider-updated signer identity before signer-level signed processing", async () => {
    const deps = dependencies();
    const response = await handleDropboxSignWebhook({
      request: callbackRequest({
        eventType: "signature_request_signed",
        relatedSignatureId: "bb67df41911f964aa66f488bd2878cbd",
        providerSignatures: [{
          signature_id: "bb67df41911f964aa66f488bd2878cbd",
          signer_role: "Seller",
          signer_name: "eSign QA A PRIMARY_E2E",
          signer_email_address: "jarrad.henry@gmail.com",
          order: 0,
          status_code: "signed",
          signed_at: 1788331417,
        }],
      }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(deps.persistence.reconcileProviderSigners).toHaveBeenCalledWith({
      orgId: ORG_ID,
      requestId: REQUEST_ID,
      claim: CLAIM,
      providerEventAt: new Date("2026-08-30T01:40:00.000Z"),
      providerSignatures: [{
        signatureId: "bb67df41911f964aa66f488bd2878cbd",
        role: "Seller",
        name: "eSign QA A PRIMARY_E2E",
        emailAddress: "jarrad.henry@gmail.com",
        order: 0,
        statusCode: "signed",
        signedAt: 1788331417,
      }],
      signedProviderSignatureId: "bb67df41911f964aa66f488bd2878cbd",
    });
    expect(deps.persistence.markReceiptProcessed).toHaveBeenCalledWith(CLAIM);
  });

  it("repairs local error state before signed completion and PDF download", async () => {
    const deps = dependencies();
    vi.mocked(deps.persistence.findRequest).mockResolvedValue({
      id: REQUEST_ID,
      orgId: ORG_ID,
      propertyId: PROPERTY_ID,
      status: "error",
      testMode: true,
      signedPdfPath: null,
      templateTitle: "Purchase Agreement",
    });
    vi.mocked(deps.persistence.applyStatusDecision).mockResolvedValue({
      outcome: "applied",
      status: "signed",
    });

    const response = await handleDropboxSignWebhook({
      request: callbackRequest({
        eventType: "signature_request_downloadable",
        relatedSignatureId: null,
        providerSignatures: [{
          signature_id: "bb67df41911f964aa66f488bd2878cbd",
          signer_role: "Seller",
          signer_name: "eSign QA A PRIMARY_E2E",
          signer_email_address: "jarrad.henry@gmail.com",
          order: 0,
          status_code: "signed",
          signed_at: 1788331417,
        }],
      }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(deps.persistence.reconcileProviderSigners).toHaveBeenCalled();
    expect(deps.persistence.applyStatusDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          previousStatus: "error",
          nextStatus: "signed",
          reason: "downloadable",
        }),
      }),
    );
    expect(deps.pdfProvider.downloadSignedPdf).toHaveBeenCalledWith({
      orgId: ORG_ID,
      callbackConsumerId: CONSUMER_ID,
      signRequestId: "provider-request-1",
    });
    expect(deps.artifactPersistence.storeLinkAndRecordReady).toHaveBeenCalled();
  });

  it("reconciles a verified reminder callback before completing its receipt", async () => {
    const deps = dependencies();
    const response = await handleDropboxSignWebhook({
      request: callbackRequest({ eventType: "signature_request_remind" }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(deps.persistence.reconcileReminderCallback).toHaveBeenCalledWith({
      orgId: ORG_ID,
      requestId: REQUEST_ID,
      claim: CLAIM,
      providerSignatureId: "provider-signature-1",
      providerEventAt: new Date("2026-08-30T01:40:00.000Z"),
    });
    expect(deps.persistence.markReceiptProcessed).toHaveBeenCalledWith(CLAIM);
    expect(deps.persistence.markReceiptIgnored).not.toHaveBeenCalled();
  });

  it("does not clear a reminder fence without provider signer identity", async () => {
    const deps = dependencies();
    const response = await handleDropboxSignWebhook({
      request: callbackRequest({
        eventType: "signature_request_remind",
        relatedSignatureId: null,
      }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(deps.persistence.reconcileReminderCallback).not.toHaveBeenCalled();
    expect(deps.persistence.markReceiptIgnored).toHaveBeenCalledWith(
      CLAIM,
      "REMINDER_WITHOUT_SIGNATURE",
    );
  });

  it("persists Signed before a retryable PDF failure and never writes Error", async () => {
    const deps = dependencies({
      pdfProvider: {
        downloadSignedPdf: vi.fn(async () => {
          throw new Error("private-seller@example.com");
        }),
      },
    });
    const response = await handleDropboxSignWebhook({
      request: callbackRequest({ eventType: "signature_request_downloadable" }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-seller@example.com");
    expect(deps.persistence.applyStatusDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ nextStatus: "signed" }),
      }),
    );
    expect(deps.persistence.applyStatusDecision).not.toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ nextStatus: "error" }),
      }),
    );
    expect(deps.persistence.markReceiptFailed).toHaveBeenCalledWith(
      CLAIM,
      "UNEXPECTED_PROCESSING_ERROR",
    );
  });

  it("stores and links a validated downloadable PDF exactly once per claim", async () => {
    const deps = dependencies();
    const response = await handleDropboxSignWebhook({
      request: callbackRequest({ eventType: "signature_request_downloadable" }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(deps.artifactPersistence.storeLinkAndRecordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        propertyId: PROPERTY_ID,
        requestId: REQUEST_ID,
        claim: CLAIM,
        artifact: expect.objectContaining({
          storageBucket: "lead-files",
          storagePath: `${ORG_ID}/${PROPERTY_ID}/esign/${REQUEST_ID}/signed.pdf`,
          contentType: "application/pdf",
        }),
      }),
    );
    expect(deps.pdfProvider.downloadSignedPdf).toHaveBeenCalledWith({
      orgId: ORG_ID,
      callbackConsumerId: CONSUMER_ID,
      signRequestId: "provider-request-1",
    });
  });

  it("does not acknowledge an actively processing duplicate", async () => {
    const deps = dependencies();
    vi.mocked(deps.persistence.claimVerifiedReceipt).mockResolvedValue({
      outcome: "in_progress",
      receiptId: "receipt-1",
    });
    const response = await handleDropboxSignWebhook({
      request: callbackRequest(),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toBe(DROPBOX_SIGN_ACKNOWLEDGEMENT);
  });

  it("does not ingest a late downloadable artifact after a different terminal state", async () => {
    const deps = dependencies();
    vi.mocked(deps.persistence.findRequest).mockResolvedValue({
      id: REQUEST_ID,
      orgId: ORG_ID,
      propertyId: PROPERTY_ID,
      status: "declined",
      testMode: true,
      signedPdfPath: null,
      templateTitle: "Purchase Agreement",
    });
    const response = await handleDropboxSignWebhook({
      request: callbackRequest({ eventType: "signature_request_downloadable" }),
      pathSecret: PATH_SECRET,
      dependencies: deps,
    });

    expect(response.status).toBe(200);
    expect(deps.pdfProvider.downloadSignedPdf).not.toHaveBeenCalled();
    expect(deps.artifactPersistence.storeLinkAndRecordReady).not.toHaveBeenCalled();
    expect(deps.persistence.markReceiptProcessed).toHaveBeenCalledWith(CLAIM);
  });
});
