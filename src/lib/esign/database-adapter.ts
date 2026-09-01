import { randomUUID } from "node:crypto";

import {
  buildEsignMaterialEventPayload,
  ESIGN_MATERIAL_EVENT_TYPES,
  materialEventTypeForStatus,
  type EsignMaterialEventPayload,
  type EsignMaterialEventType,
} from "./material-events";
import type {
  ActiveReceiptClaim,
  ApplyStatusDecisionResult,
  EsignWebhookPersistence,
  ReceiptClaimResult,
  SignedPdfArtifactLinkPersistence,
  VerifiedReceiptInput,
} from "./ports";
import type { EsignStatus } from "./status";

export const ESIGN_WEBHOOK_RPC_NAMES = {
  CLAIM_RECEIPT: "claim_esign_webhook_receipt",
  FIND_REQUEST: "find_esign_webhook_request",
  APPLY_STATUS: "apply_esign_webhook_status_decision",
  RECONCILE_REMINDER: "reconcile_esign_reminder_callback",
  LINK_ARTIFACT: "link_esign_signed_artifact",
  COMPLETE_RECEIPT: "complete_esign_webhook_receipt",
} as const;

export type SafeEventData = {
  event_time: string;
  event_type: string;
  sign_request_id: string | null;
  related_signature_id: string | null;
  reported_for_app_id: string | null;
};

export type EsignWebhookRpcContract = {
  claim_esign_webhook_receipt: {
    args: {
      p_org_id: string;
      p_callback_consumer_id: string;
      p_event_hash: string;
      p_event_fingerprint: string;
      p_payload_hash: string;
      p_event_type: string;
      p_sign_request_id: string | null;
      p_related_signature_id: string | null;
      p_provider_event_at: string;
      p_safe_event_data: SafeEventData;
      p_received_at: string;
      p_lease_id: string;
      p_stale_after_seconds: number;
    };
    result: Array<{
      outcome: "claimed" | "already_processed" | "in_progress";
      receipt_id: string;
      lease_id: string | null;
    }>;
  };
  find_esign_webhook_request: {
    args: { p_org_id: string; p_sign_request_id: string };
    result: Array<{
      id: string;
      org_id: string;
      property_id: string;
      status: EsignStatus;
      signed_pdf_path: string | null;
      template_title: string;
    }>;
  };
  apply_esign_webhook_status_decision: {
    args: {
      p_org_id: string;
      p_request_id: string;
      p_receipt_id: string;
      p_lease_id: string;
      p_expected_status: EsignStatus;
      p_requested_status: EsignStatus;
      p_provider_event_at: string;
      p_lead_event_type: Exclude<
        EsignMaterialEventType,
        "esign_signed_pdf_ready"
      > | null;
      p_lead_event_payload: EsignMaterialEventPayload | null;
    };
    result: Array<ApplyStatusDecisionResult>;
  };
  reconcile_esign_reminder_callback: {
    args: {
      p_org_id: string;
      p_request_id: string;
      p_receipt_id: string;
      p_lease_id: string;
      p_provider_signature_id: string;
      p_provider_event_at: string;
    };
    result: Array<{
      outcome:
        "applied" | "already_reconciled" | "stale_ignored" | "superseded";
    }>;
  };
  link_esign_signed_artifact: {
    args: {
      p_org_id: string;
      p_request_id: string;
      p_receipt_id: string;
      p_lease_id: string;
      p_lead_file_id: string;
      p_storage_bucket: string;
      p_storage_path: string;
      p_content_type: "application/pdf";
      p_size_bytes: number;
      p_lead_event_type: "esign_signed_pdf_ready";
      p_lead_event_payload: EsignMaterialEventPayload;
    };
    result: Array<{
      outcome: "applied" | "already_linked";
      lead_file_id: string;
    }>;
  };
  complete_esign_webhook_receipt: {
    args: {
      p_receipt_id: string;
      p_lease_id: string;
      p_status: "processed" | "ignored" | "error";
      p_safe_code: string | null;
    };
    result: null;
  };
};

export type EsignWebhookRpcName = keyof EsignWebhookRpcContract;

export interface EsignWebhookRpcClient {
  rpc<Name extends EsignWebhookRpcName>(
    name: Name,
    args: EsignWebhookRpcContract[Name]["args"],
  ): Promise<{
    data: EsignWebhookRpcContract[Name]["result"] | null;
    error: { code?: string } | null;
  }>;
}

export type EsignWebhookDatabaseAdapter = EsignWebhookPersistence &
  SignedPdfArtifactLinkPersistence;

const DEFAULT_STALE_AFTER_SECONDS = 300;
const MIN_STALE_AFTER_SECONDS = 60;
const MAX_STALE_AFTER_SECONDS = 3_600;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function createEsignWebhookDatabaseAdapter(
  client: EsignWebhookRpcClient,
  options: {
    createLeaseId?: () => string;
    staleAfterSeconds?: number;
  } = {},
): EsignWebhookDatabaseAdapter {
  const createLeaseId = options.createLeaseId ?? randomUUID;
  const staleAfterSeconds =
    options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  if (
    !Number.isSafeInteger(staleAfterSeconds) ||
    staleAfterSeconds < MIN_STALE_AFTER_SECONDS ||
    staleAfterSeconds > MAX_STALE_AFTER_SECONDS
  ) {
    throw new EsignDatabaseAdapterError("INVALID_ADAPTER_CONFIG");
  }

  return {
    async claimVerifiedReceipt(input) {
      const leaseId = createLeaseId();
      const providerEventAt = providerEventIso(input.replay.eventTime);
      const result = await callRpc(
        client,
        ESIGN_WEBHOOK_RPC_NAMES.CLAIM_RECEIPT,
        {
          p_org_id: input.orgId,
          p_callback_consumer_id: input.callbackConsumerId,
          p_event_hash: input.replay.eventHash,
          p_event_fingerprint: input.fingerprint,
          p_payload_hash: input.replay.payloadHash,
          p_event_type: input.replay.eventType,
          p_sign_request_id: input.replay.signRequestId,
          p_related_signature_id: input.replay.relatedSignatureId,
          p_provider_event_at: providerEventAt,
          p_safe_event_data: safeEventData(input),
          p_received_at: input.receivedAt.toISOString(),
          p_lease_id: leaseId,
          p_stale_after_seconds: staleAfterSeconds,
        },
      );
      const row = exactlyOne(result);
      if (!isReceiptOutcome(row.outcome) || !isNonEmptyString(row.receipt_id)) {
        invalidResponse();
      }
      if (row.outcome === "claimed") {
        if (row.lease_id !== leaseId) invalidResponse();
        return { outcome: "claimed", receiptId: row.receipt_id, leaseId };
      }
      if (row.lease_id !== null) invalidResponse();
      return { outcome: row.outcome, receiptId: row.receipt_id };
    },

    async findRequest(input) {
      const rows = await callRpc(client, ESIGN_WEBHOOK_RPC_NAMES.FIND_REQUEST, {
        p_org_id: input.orgId,
        p_sign_request_id: input.signRequestId,
      });
      if (rows.length === 0) return null;
      const row = exactlyOne(rows);
      if (
        !isNonEmptyString(row.id) ||
        !isNonEmptyString(row.org_id) ||
        !isNonEmptyString(row.property_id) ||
        !isEsignStatus(row.status) ||
        (row.signed_pdf_path !== null &&
          typeof row.signed_pdf_path !== "string") ||
        typeof row.template_title !== "string"
      ) {
        invalidResponse();
      }
      return {
        id: row.id,
        orgId: row.org_id,
        propertyId: row.property_id,
        status: row.status,
        signedPdfPath: row.signed_pdf_path,
        templateTitle: row.template_title,
      };
    },

    async applyStatusDecision(input) {
      const eventType = materialEventTypeForStatus(input.requestedStatus);
      const payload = eventType
        ? buildEsignMaterialEventPayload(input.templateTitle)
        : null;
      const rows = await callRpc(client, ESIGN_WEBHOOK_RPC_NAMES.APPLY_STATUS, {
        p_org_id: input.orgId,
        p_request_id: input.requestId,
        p_receipt_id: input.claim.receiptId,
        p_lease_id: input.claim.leaseId,
        p_expected_status: input.decision.previousStatus,
        p_requested_status: input.requestedStatus,
        p_provider_event_at: input.providerEventAt.toISOString(),
        p_lead_event_type: eventType,
        p_lead_event_payload: payload,
      });
      const row = exactlyOne(rows);
      if (!isApplyOutcome(row.outcome) || !isEsignStatus(row.status)) {
        invalidResponse();
      }
      return row;
    },

    async reconcileReminderCallback(input) {
      const rows = await callRpc(
        client,
        ESIGN_WEBHOOK_RPC_NAMES.RECONCILE_REMINDER,
        {
          p_org_id: input.orgId,
          p_request_id: input.requestId,
          p_receipt_id: input.claim.receiptId,
          p_lease_id: input.claim.leaseId,
          p_provider_signature_id: input.providerSignatureId,
          p_provider_event_at: input.providerEventAt.toISOString(),
        },
      );
      const row = exactlyOne(rows);
      if (!isReminderReconciliationOutcome(row.outcome)) invalidResponse();
      return row.outcome;
    },

    async markReceiptProcessed(claim) {
      await completeReceipt(client, claim, "processed", null);
    },

    async markReceiptIgnored(claim, safeReasonCode) {
      await completeReceipt(
        client,
        claim,
        "ignored",
        validateSafeCode(safeReasonCode),
      );
    },

    async markReceiptFailed(claim, safeErrorCode) {
      await completeReceipt(
        client,
        claim,
        "error",
        validateSafeCode(safeErrorCode),
      );
    },

    async linkSignedArtifact(input) {
      const rows = await callRpc(client, ESIGN_WEBHOOK_RPC_NAMES.LINK_ARTIFACT, {
        p_org_id: input.orgId,
        p_request_id: input.requestId,
        p_receipt_id: input.claim.receiptId,
        p_lease_id: input.claim.leaseId,
        p_lead_file_id: input.claim.receiptId,
        p_storage_bucket: input.artifact.storageBucket,
        p_storage_path: input.artifact.storagePath,
        p_content_type: input.artifact.contentType,
        p_size_bytes: input.artifact.sizeBytes,
        p_lead_event_type: ESIGN_MATERIAL_EVENT_TYPES.SIGNED_PDF_READY,
        p_lead_event_payload: buildEsignMaterialEventPayload(input.templateTitle),
      });
      const row = exactlyOne(rows);
      if (!isLinkOutcome(row.outcome) || !isNonEmptyString(row.lead_file_id)) {
        invalidResponse();
      }
      return { outcome: row.outcome, leadFileId: row.lead_file_id };
    },
  };
}

async function completeReceipt(
  client: EsignWebhookRpcClient,
  claim: ActiveReceiptClaim,
  status: "processed" | "ignored" | "error",
  safeCode: string | null,
): Promise<void> {
  const result = await client.rpc(ESIGN_WEBHOOK_RPC_NAMES.COMPLETE_RECEIPT, {
    p_receipt_id: claim.receiptId,
    p_lease_id: claim.leaseId,
    p_status: status,
    p_safe_code: safeCode,
  });
  if (result.error) {
    throw new EsignDatabaseAdapterError("RPC_FAILED");
  }
}

function safeEventData(input: VerifiedReceiptInput): SafeEventData {
  return {
    event_time: input.replay.eventTime,
    event_type: input.replay.eventType,
    sign_request_id: input.replay.signRequestId,
    related_signature_id: input.replay.relatedSignatureId,
    reported_for_app_id: input.replay.reportedForAppId,
  };
}

async function callRpc<Name extends EsignWebhookRpcName>(
  client: EsignWebhookRpcClient,
  name: Name,
  args: EsignWebhookRpcContract[Name]["args"],
): Promise<NonNullable<EsignWebhookRpcContract[Name]["result"]>> {
  const result = await client.rpc(name, args);
  if (result.error || result.data === null) {
    throw new EsignDatabaseAdapterError("RPC_FAILED");
  }
  return result.data as NonNullable<EsignWebhookRpcContract[Name]["result"]>;
}

function exactlyOne<T>(rows: T[]): T {
  if (!Array.isArray(rows) || rows.length !== 1) invalidResponse();
  return rows[0];
}

function providerEventIso(eventTime: string): string {
  const date = new Date(Number(eventTime) * 1_000);
  if (!Number.isFinite(date.getTime())) {
    throw new EsignDatabaseAdapterError("INVALID_PROVIDER_EVENT_TIME");
  }
  return date.toISOString();
}

function validateSafeCode(code: string): string {
  if (!SAFE_CODE_PATTERN.test(code)) {
    throw new EsignDatabaseAdapterError("INVALID_SAFE_CODE");
  }
  return code;
}

function isReceiptOutcome(value: unknown): value is ReceiptClaimResult["outcome"] {
  return (
    value === "claimed" ||
    value === "already_processed" ||
    value === "in_progress"
  );
}

function isApplyOutcome(
  value: unknown,
): value is ApplyStatusDecisionResult["outcome"] {
  return (
    value === "applied" ||
    value === "no_change" ||
    value === "terminal_ignored"
  );
}

function isReminderReconciliationOutcome(
  value: unknown,
): value is "applied" | "already_reconciled" | "stale_ignored" | "superseded" {
  return (
    value === "applied" ||
    value === "already_reconciled" ||
    value === "stale_ignored" ||
    value === "superseded"
  );
}

function isLinkOutcome(value: unknown): value is "applied" | "already_linked" {
  return value === "applied" || value === "already_linked";
}

function isEsignStatus(value: unknown): value is EsignStatus {
  return (
    value === "awaiting" ||
    value === "viewed" ||
    value === "signed" ||
    value === "declined" ||
    value === "voided" ||
    value === "error"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function invalidResponse(): never {
  throw new EsignDatabaseAdapterError("INVALID_RPC_RESPONSE");
}

export type EsignDatabaseAdapterErrorCode =
  | "INVALID_ADAPTER_CONFIG"
  | "INVALID_PROVIDER_EVENT_TIME"
  | "INVALID_RPC_RESPONSE"
  | "INVALID_SAFE_CODE"
  | "RPC_FAILED";

export class EsignDatabaseAdapterError extends Error {
  constructor(public readonly code: EsignDatabaseAdapterErrorCode) {
    super("The eSign webhook database operation failed.");
    this.name = "EsignDatabaseAdapterError";
  }
}
