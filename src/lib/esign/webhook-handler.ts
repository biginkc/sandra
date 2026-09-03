import { createHash } from "node:crypto";

import {
  DropboxCallbackValidationError,
  buildDropboxSignReceiptFingerprint,
  parseDropboxSignCallbackFormData,
  verifyDropboxSignEventHash,
  type DropboxSignReplayData,
} from "./dropbox-callback";
import type {
  ActiveReceiptClaim,
  DropboxSignEventAuthenticator,
  EsignWebhookDependencies,
} from "./ports";
import { buildSignedPdfArtifact, SignedPdfValidationError } from "./signed-pdf";
import {
  normalizeDropboxSignLifecycleEvent,
  reduceEsignStatus,
} from "./status";

export const DROPBOX_SIGN_ACKNOWLEDGEMENT = "Hello API Event Received";

const CALLBACK_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

class SafeWebhookProcessingError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super("Dropbox Sign callback processing failed.");
    this.name = "SafeWebhookProcessingError";
  }
}

export function createDropboxSignEventAuthenticator(input: {
  loadCredentials: (input: {
    orgId: string;
    callbackConsumerId: string;
  }) => Promise<{
    apiKey: { reveal(): string };
    clientId: string;
  } | null>;
}): DropboxSignEventAuthenticator {
  return {
    async verifyForIntegration({ orgId, callbackConsumerId, replay }) {
      const credentials = await input.loadCredentials({ orgId, callbackConsumerId });
      if (!credentials) return false;
      if (
        replay.reportedForAppId !== null &&
        replay.reportedForAppId !== credentials.clientId
      ) {
        return false;
      }
      return verifyDropboxSignEventHash(replay, credentials.apiKey.reveal());
    },
  };
}

export async function handleDropboxSignWebhook(input: {
  request: Request;
  pathSecret: string;
  dependencies: EsignWebhookDependencies;
}): Promise<Response> {
  let activeClaim: ActiveReceiptClaim | null = null;
  try {
    const identity = await resolveCallbackIdentity(
      input.pathSecret,
      input.dependencies,
    );
    if (!identity) return plainResponse("Forbidden", 403);

    const replay = await parseRequest(input.request);
    const authentic = await input.dependencies.authenticator.verifyForIntegration({
      ...identity,
      replay,
    });
    if (!authentic) return plainResponse("Forbidden", 403);

    const claim = await input.dependencies.persistence.claimVerifiedReceipt({
      ...identity,
      fingerprint: buildDropboxSignReceiptFingerprint(replay),
      replay,
      receivedAt: new Date(),
    });
    if (claim.outcome === "already_processed") return acknowledgement();
    if (claim.outcome === "in_progress") {
      return plainResponse("Callback processing is in progress", 503);
    }
    activeClaim = claim;

    if (replay.signRequestId === null) {
      await input.dependencies.persistence.markReceiptIgnored(
        activeClaim,
        "CALLBACK_WITHOUT_REQUEST",
      );
      return acknowledgement();
    }

    let request = await input.dependencies.persistence.findRequest({
      orgId: identity.orgId,
      signRequestId: replay.signRequestId,
      verifiedLocalRequestId: null,
    });
    if (!request && replay.localRequestId !== null) {
      // Dropbox callbacks may omit test_mode. In that recovery path Sandra can
      // only prove provider metadata and the stored local request mode; when
      // provider mode cannot be confirmed, keep the callback retryable.
      const metadataMatch =
        await input.dependencies.metadataProvider.confirmProviderLocalRequestId({
          ...identity,
          signRequestId: replay.signRequestId,
          localRequestId: replay.localRequestId,
          testMode: replay.testMode ?? null,
        });
      if (metadataMatch === "matched") {
        request = await input.dependencies.persistence.findRequest({
          orgId: identity.orgId,
          signRequestId: replay.signRequestId,
          verifiedLocalRequestId: replay.localRequestId,
        });
      } else if (metadataMatch === "mode_unverified") {
        throw new SafeWebhookProcessingError("PROVIDER_MODE_UNVERIFIED", 503);
      } else {
        await input.dependencies.persistence.markReceiptIgnored(
          activeClaim,
          "PROVIDER_METADATA_MISMATCH",
        );
        return acknowledgement();
      }
    }
    if (!request || request.orgId !== identity.orgId) {
      throw new SafeWebhookProcessingError("REQUEST_NOT_FOUND", 503);
    }
    if (replay.testMode != null && replay.testMode !== request.testMode) {
      await input.dependencies.persistence.markReceiptIgnored(
        activeClaim,
        "REQUEST_MODE_MISMATCH",
      );
      return acknowledgement();
    }

    const providerEventAt = providerEventDate(replay);

    const supportsSignerReconciliation =
      replay.eventType === "signature_request_viewed" ||
      replay.eventType === "signature_request_signed" ||
      replay.eventType === "signature_request_all_signed" ||
      replay.eventType === "signature_request_downloadable" ||
      replay.eventType === "signature_request_declined" ||
      replay.eventType === "signature_request_remind";
    const signerReconciliation =
      supportsSignerReconciliation &&
      (replay.providerSignatures.length > 0 ||
        replay.eventType === "signature_request_signed")
        ? await input.dependencies.persistence.reconcileProviderSigners({
            orgId: identity.orgId,
            requestId: request.id,
            claim: activeClaim,
            providerEventAt,
            providerSignatures: replay.providerSignatures,
            signedProviderSignatureId: replay.relatedSignatureId,
          })
        : null;
    if (
      signerReconciliation === "unavailable" &&
      (request.status === "error" ||
        replay.providerSignatures.length > 0)
    ) {
      throw new SafeWebhookProcessingError("SIGNER_RECONCILE_UNAVAILABLE", 503);
    }

    if (replay.eventType === "signature_request_remind") {
      if (replay.relatedSignatureId === null) {
        await input.dependencies.persistence.markReceiptIgnored(
          activeClaim,
          "REMINDER_WITHOUT_SIGNATURE",
        );
        return acknowledgement();
      }
      await input.dependencies.persistence.reconcileReminderCallback({
        orgId: identity.orgId,
        requestId: request.id,
        claim: activeClaim,
        providerSignatureId: replay.relatedSignatureId,
        providerEventAt,
      });
      await input.dependencies.persistence.markReceiptProcessed(activeClaim);
      return acknowledgement();
    }

    const normalized = normalizeDropboxSignLifecycleEvent(replay.eventType);
    if (replay.eventType === "signature_request_signed") {
      if (signerReconciliation === "unavailable") {
        await input.dependencies.persistence.markReceiptIgnored(
          activeClaim,
          "AUDIT_ONLY_EVENT",
        );
        return acknowledgement();
      }
      await input.dependencies.persistence.markReceiptProcessed(activeClaim);
      return acknowledgement();
    }
    const decision = reduceEsignStatus(request.status, normalized);
    if (normalized.requestedStatus === null && !normalized.artifactReady) {
      await input.dependencies.persistence.markReceiptIgnored(
        activeClaim,
        "AUDIT_ONLY_EVENT",
      );
      return acknowledgement();
    }

    let authoritativeStatus = request.status;
    if (normalized.requestedStatus !== null) {
      const transition = normalized.reason === "email_bounced"
        ? await input.dependencies.persistence.applyEmailBounceDecision({
            orgId: identity.orgId,
            requestId: request.id,
            claim: activeClaim,
            decision,
            providerEventAt,
          })
        : await input.dependencies.persistence.applyStatusDecision({
          orgId: identity.orgId,
          requestId: request.id,
          propertyId: request.propertyId,
          claim: activeClaim,
          decision,
          requestedStatus: normalized.requestedStatus,
          providerEventAt,
          templateTitle: request.templateTitle,
        });
      if (transition === null) {
        throw new SafeWebhookProcessingError(
          "EMAIL_BOUNCE_RPC_UNAVAILABLE",
          503,
        );
      }
      authoritativeStatus = transition.status;
      if (
        request.status === "error" &&
        normalized.requestedStatus === "signed" &&
        transition.status !== "signed"
      ) {
        throw new SafeWebhookProcessingError("SIGNED_RECOVERY_UNAVAILABLE", 503);
      }
    }

    if (
      normalized.artifactReady &&
      authoritativeStatus === "signed" &&
      request.signedPdfPath === null
    ) {
      const pdf = await input.dependencies.pdfProvider.downloadSignedPdf({
        ...identity,
        signRequestId: replay.signRequestId,
      });
      const artifact = buildSignedPdfArtifact({
        orgId: identity.orgId,
        propertyId: request.propertyId,
        requestId: request.id,
        pdf,
        maxBytes: input.dependencies.signedPdfMaxBytes,
      });
      await input.dependencies.artifactPersistence.storeLinkAndRecordReady({
        orgId: identity.orgId,
        propertyId: request.propertyId,
        requestId: request.id,
        claim: activeClaim,
        templateTitle: request.templateTitle,
        pdf,
        artifact,
      });
    }

    await input.dependencies.persistence.markReceiptProcessed(activeClaim);
    return acknowledgement();
  } catch (error) {
    const safe = safeProcessingFailure(error);
    if (activeClaim !== null) {
      try {
        await input.dependencies.persistence.markReceiptFailed(activeClaim, safe.code);
      } catch {
        // The provider must receive a retryable response even if failure marking fails.
      }
    }
    return plainResponse("Callback processing failed", safe.status);
  }
}

async function resolveCallbackIdentity(
  secret: string,
  dependencies: EsignWebhookDependencies,
): Promise<{ orgId: string; callbackConsumerId: string } | null> {
  if (!CALLBACK_SECRET_PATTERN.test(secret)) return null;
  const secretHash = createHash("sha256").update(secret, "utf8").digest("hex");
  return dependencies.secretResolver.resolvePathSecretHash(secretHash);
}

async function parseRequest(request: Request): Promise<DropboxSignReplayData> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    throw new SafeWebhookProcessingError("INVALID_MULTIPART", 400);
  }
  try {
    return parseDropboxSignCallbackFormData(formData);
  } catch (error) {
    if (error instanceof DropboxCallbackValidationError) {
      throw new SafeWebhookProcessingError(error.code, 400);
    }
    throw error;
  }
}

function providerEventDate(replay: DropboxSignReplayData): Date {
  const date = new Date(Number(replay.eventTime) * 1_000);
  if (!Number.isFinite(date.getTime())) {
    throw new SafeWebhookProcessingError("INVALID_EVENT_TIME", 400);
  }
  return date;
}

function safeProcessingFailure(error: unknown): {
  code: string;
  status: number;
} {
  if (error instanceof SafeWebhookProcessingError) {
    return { code: error.code, status: error.status };
  }
  if (error instanceof SignedPdfValidationError) {
    return { code: error.code, status: 503 };
  }
  return { code: "UNEXPECTED_PROCESSING_ERROR", status: 503 };
}

function acknowledgement(): Response {
  return plainResponse(DROPBOX_SIGN_ACKNOWLEDGEMENT, 200);
}

function plainResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
