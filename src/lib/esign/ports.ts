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
  | { outcome: "claimed"; receiptId: string; leaseId: string }
  | { outcome: "already_processed"; receiptId: string }
  | { outcome: "in_progress"; receiptId: string };

export type ActiveReceiptClaim = Extract<ReceiptClaimResult, { outcome: "claimed" }>;

export type ApplyStatusDecisionResult = {
  outcome: "applied" | "no_change" | "terminal_ignored";
  status: EsignStatus;
};

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
    templateTitle: string;
  } | null>;
  applyStatusDecision(input: {
    orgId: string;
    requestId: string;
    propertyId: string;
    claim: ActiveReceiptClaim;
    decision: EsignStatusDecision;
    requestedStatus: EsignStatus;
    providerEventAt: Date;
    templateTitle: string;
  }): Promise<ApplyStatusDecisionResult>;
  markReceiptProcessed(claim: ActiveReceiptClaim): Promise<void>;
  markReceiptIgnored(
    claim: ActiveReceiptClaim,
    safeReasonCode: string,
  ): Promise<void>;
  markReceiptFailed(
    claim: ActiveReceiptClaim,
    safeErrorCode: string,
  ): Promise<void>;
}

export interface DropboxSignedPdfProvider {
  downloadSignedPdf(input: {
    orgId: string;
    callbackConsumerId: string;
    signRequestId: string;
  }): Promise<Buffer>;
}

export interface SignedPdfArtifactPersistence {
  /** Store privately, link lead_files/request, and record PDF-ready idempotently. */
  storeLinkAndRecordReady(input: {
    orgId: string;
    propertyId: string;
    requestId: string;
    claim: ActiveReceiptClaim;
    templateTitle: string;
    pdf: Buffer;
    artifact: SignedPdfArtifact;
  }): Promise<{ outcome: "applied" | "already_linked"; leadFileId: string }>;
}

/** Database-only half of artifact persistence; object upload remains separate. */
export interface SignedPdfArtifactLinkPersistence {
  linkSignedArtifact(input: {
    orgId: string;
    requestId: string;
    claim: ActiveReceiptClaim;
    templateTitle: string;
    artifact: SignedPdfArtifact;
  }): Promise<{ outcome: "applied" | "already_linked"; leadFileId: string }>;
}

export type EsignWebhookDependencies = {
  secretResolver: EsignCallbackSecretResolver;
  authenticator: DropboxSignEventAuthenticator;
  persistence: EsignWebhookPersistence;
  pdfProvider: DropboxSignedPdfProvider;
  artifactPersistence: SignedPdfArtifactPersistence;
  signedPdfMaxBytes?: number;
};
