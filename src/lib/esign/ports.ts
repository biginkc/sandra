import type { DropboxSignReplayData } from "./dropbox-callback";
import type { SignedPdfArtifact } from "./signed-pdf";
import type { EsignStatus, EsignStatusDecision } from "./status";

export type VerifiedReceiptInput = {
  orgId: string;
  callbackConsumerId: string;
  fingerprint: string;
  replay: DropboxSignReplayData;
  receivedAt: Date;
};

export type ReceiptClaimResult =
  | { outcome: "claimed"; receiptId: string }
  | { outcome: "already_processed"; receiptId: string }
  | { outcome: "in_progress"; receiptId: string };

export interface EsignCallbackSecretResolver {
  resolvePathSecretHash(secretHash: string): Promise<{
    orgId: string;
    callbackConsumerId: string;
  } | null>;
}

export interface DropboxSignEventAuthenticator {
  verifyForIntegration(input: {
    orgId: string;
    callbackConsumerId: string;
    replay: DropboxSignReplayData;
  }): Promise<boolean>;
}

export interface EsignWebhookPersistence {
  claimVerifiedReceipt(input: VerifiedReceiptInput): Promise<ReceiptClaimResult>;
  findRequest(input: {
    orgId: string;
    signRequestId: string;
  }): Promise<{
    id: string;
    orgId: string;
    propertyId: string;
    status: EsignStatus;
    signedPdfPath: string | null;
  } | null>;
  applyStatusDecision(input: {
    orgId: string;
    requestId: string;
    decision: EsignStatusDecision;
    providerEventAt: Date;
  }): Promise<"updated" | "stale">;
  markReceiptProcessed(receiptId: string): Promise<void>;
  markReceiptIgnored(receiptId: string, safeReasonCode: string): Promise<void>;
  markReceiptFailed(receiptId: string, safeErrorCode: string): Promise<void>;
}

export interface DropboxSignedPdfProvider {
  downloadSignedPdf(signRequestId: string): Promise<Buffer>;
}

export interface SignedPdfArtifactPersistence {
  storeAndLink(input: {
    orgId: string;
    propertyId: string;
    requestId: string;
    pdf: Buffer;
    artifact: SignedPdfArtifact;
  }): Promise<{ outcome: "created" | "already_linked"; leadFileId: string }>;
}
