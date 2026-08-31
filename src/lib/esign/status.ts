export { ESIGN_STATUSES, type EsignStatus } from "./contracts";

import type { EsignStatus } from "./contracts";

export type NormalizedEsignLifecycleEvent = {
  eventType: string;
  requestedStatus: EsignStatus | null;
  artifactReady: boolean;
  reason:
    | "viewed"
    | "all_signed"
    | "downloadable"
    | "declined"
    | "canceled"
    | "provider_error"
    | "audit_only";
};

export type EsignStatusDecision = {
  previousStatus: EsignStatus;
  nextStatus: EsignStatus;
  changed: boolean;
  artifactReady: boolean;
  reason: NormalizedEsignLifecycleEvent["reason"] | "terminal_sticky";
};

const TERMINAL_STATUSES: ReadonlySet<EsignStatus> = new Set([
  "signed",
  "declined",
  "voided",
  "error",
]);

export function normalizeDropboxSignLifecycleEvent(
  eventType: string,
): NormalizedEsignLifecycleEvent {
  switch (eventType) {
    case "signature_request_viewed":
      return lifecycle(eventType, "viewed", false, "viewed");
    case "signature_request_all_signed":
      return lifecycle(eventType, "signed", false, "all_signed");
    case "signature_request_downloadable":
      return lifecycle(eventType, "signed", true, "downloadable");
    case "signature_request_declined":
      return lifecycle(eventType, "declined", false, "declined");
    case "signature_request_canceled":
      return lifecycle(eventType, "voided", false, "canceled");
    case "signature_request_invalid":
    case "signature_request_expired":
    case "signature_request_email_bounce":
      return lifecycle(eventType, "error", false, "provider_error");
    default:
      return lifecycle(eventType, null, false, "audit_only");
  }
}

export function reduceEsignStatus(
  currentStatus: EsignStatus,
  event: NormalizedEsignLifecycleEvent,
): EsignStatusDecision {
  if (TERMINAL_STATUSES.has(currentStatus)) {
    return {
      previousStatus: currentStatus,
      nextStatus: currentStatus,
      changed: false,
      artifactReady: event.artifactReady,
      reason:
        event.requestedStatus === currentStatus ? event.reason : "terminal_sticky",
    };
  }

  if (event.requestedStatus === null) {
    return unchanged(currentStatus, event);
  }
  if (currentStatus === "viewed" && event.requestedStatus === "viewed") {
    return unchanged(currentStatus, event);
  }

  return {
    previousStatus: currentStatus,
    nextStatus: event.requestedStatus,
    changed: currentStatus !== event.requestedStatus,
    artifactReady: event.artifactReady,
    reason: event.reason,
  };
}

function lifecycle(
  eventType: string,
  requestedStatus: EsignStatus | null,
  artifactReady: boolean,
  reason: NormalizedEsignLifecycleEvent["reason"],
): NormalizedEsignLifecycleEvent {
  return { eventType, requestedStatus, artifactReady, reason };
}

function unchanged(
  status: EsignStatus,
  event: NormalizedEsignLifecycleEvent,
): EsignStatusDecision {
  return {
    previousStatus: status,
    nextStatus: status,
    changed: false,
    artifactReady: event.artifactReady,
    reason: event.reason,
  };
}
