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
          related_signature_id: "provider-signature-1",
          reported_for_app_id: "client-1",
        },
      },
      ...(input.signRequestId === null
        ? {}
        : {
            signature_request: {
              signature_request_id:
                input.signRequestId ?? "provider-request-1",
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
      signedPdfPath: null,
      templateTitle: "Purchase Agreement",
    })),
    applyStatusDecision: vi.fn(async ({ decision }) => ({
      outcome: "applied" as const,
      status: decision.nextStatus,
    })),
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
    expect(deps.persistence.markReceiptIgnored).toHaveBeenCalledWith(
      CLAIM,
      "AUDIT_ONLY_EVENT",
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
