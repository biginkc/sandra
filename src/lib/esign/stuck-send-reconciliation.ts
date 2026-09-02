export const ESIGN_STUCK_SEND_MIN_AGE_MS = 15 * 60 * 1_000;
export const ESIGN_UNKNOWN_SEND_RESOLUTION_MIN_AGE_MS = 60 * 60 * 1_000;
export const ESIGN_UNKNOWN_SEND_ZERO_OBSERVATION_THRESHOLD = 3;
const ESIGN_STUCK_SEND_BATCH_SIZE = 10;

export type StuckEsignSend = Readonly<{
  id: string;
  orgId: string;
  propertyId: string;
  testMode: boolean;
  deliveryState: "sending" | "send_unknown";
  updatedAt: Date;
}>;

export type StuckSendReconciliationPorts = Readonly<{
  listCandidates(input: {
    staleBefore: Date;
    limit: number;
  }): Promise<readonly StuckEsignSend[]>;
  lookupProviderRequest(input: StuckEsignSend): Promise<{
    complete: boolean;
    providerRequestIds: readonly string[];
  }>;
  markOutcome(input: Omit<StuckEsignSend, "deliveryState"> & ({
    deliveryState: "send_unknown" | "failed";
    safeErrorMessage: string | null;
    resolutionSource?: "automatic";
    evidence?: Record<string, unknown>;
  } | {
    deliveryState: "sent";
    providerRequestId: string;
    resolutionSource: "automatic";
    evidence: Record<string, unknown>;
  })): Promise<"updated" | "raced">;
  recordZeroResult(input: StuckEsignSend & {
    observedAt: Date;
  }): Promise<{
    consecutiveCompleteZeroCount: number;
    firstObservedAt: Date | null;
  }>;
  reportOutcomeError?(error: unknown, candidate: StuckEsignSend): void;
  reportLookupError?(error: unknown, candidate: StuckEsignSend): void;
  shouldContinue?(): boolean;
}>;

export async function lookupAfterVerifiedProviderProbe(input: {
  candidate: StuckEsignSend;
  reference: Readonly<{
    localRequestId: string;
    providerRequestId: string;
  }> | null;
  find(localRequestId: string, testMode: boolean): Promise<{
    complete: boolean;
    providerRequestIds: readonly string[];
  }>;
}) {
  if (!input.reference) {
    return { complete: false, providerRequestIds: [] };
  }
  const probe = await input.find(
    input.reference.localRequestId,
    input.candidate.testMode,
  );
  if (
    !probe.complete ||
    !probe.providerRequestIds.includes(input.reference.providerRequestId)
  ) {
    return { complete: false, providerRequestIds: [] };
  }
  return input.find(input.candidate.id, input.candidate.testMode);
}

export async function reconcileStuckEsignSends(
  ports: StuckSendReconciliationPorts,
  now = new Date(),
) {
  const candidates = await ports.listCandidates({
    staleBefore: new Date(now.getTime() - ESIGN_STUCK_SEND_MIN_AGE_MS),
    limit: ESIGN_STUCK_SEND_BATCH_SIZE,
  });
  const summary = {
    checked: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
    deferred: 0,
    lookupErrors: 0,
    raced: 0,
    errors: 0,
  };
  for (const candidate of candidates) {
    if (ports.shouldContinue && !ports.shouldContinue()) break;
    summary.checked += 1;
    let lookup: Awaited<
      ReturnType<StuckSendReconciliationPorts["lookupProviderRequest"]>
    >;
    try {
      lookup = await ports.lookupProviderRequest(candidate);
    } catch (error) {
      summary.lookupErrors += 1;
      ports.reportLookupError?.(error, candidate);
      continue;
    }
    if (!lookup.complete) {
      summary.deferred += 1;
      continue;
    }
    if (lookup.providerRequestIds.length === 0) {
      let zeroEvidence: Awaited<
        ReturnType<StuckSendReconciliationPorts["recordZeroResult"]>
      >;
      try {
        zeroEvidence = await ports.recordZeroResult({
          ...candidate,
          observedAt: now,
        });
      } catch (error) {
        summary.errors += 1;
        ports.reportOutcomeError?.(error, candidate);
        continue;
      }
      try {
        const shouldFail = shouldResolveUnknownSendAsFailed({
          candidate,
          now,
          zeroEvidence,
        });
        if (shouldFail) {
          const result = await ports.markOutcome({
            ...candidate,
            deliveryState: "failed",
            safeErrorMessage: "PROVIDER_SEND_NOT_FOUND",
            resolutionSource: "automatic",
            evidence: {
              zeroObservationThreshold:
                ESIGN_UNKNOWN_SEND_ZERO_OBSERVATION_THRESHOLD,
              consecutiveCompleteZeroCount:
                zeroEvidence.consecutiveCompleteZeroCount,
              firstObservedAt: zeroEvidence.firstObservedAt?.toISOString(),
              observedAt: now.toISOString(),
              minimumUnknownAgeMs: ESIGN_UNKNOWN_SEND_RESOLUTION_MIN_AGE_MS,
              positiveControl: "passed",
            },
          });
          summary[result === "raced" ? "raced" : "failed"] += 1;
        } else if (candidate.deliveryState === "sending") {
          const result = await ports.markOutcome({
            ...candidate,
            deliveryState: "send_unknown",
            safeErrorMessage: null,
          });
          summary[result === "raced" ? "raced" : "unknown"] += 1;
        } else {
          summary.deferred += 1;
        }
      } catch (error) {
        summary.errors += 1;
        ports.reportOutcomeError?.(error, candidate);
      }
      continue;
    }
    try {
      const providerRequestId = lookup.providerRequestIds[0];
      if (providerRequestId) {
        const result = await ports.markOutcome({
          ...candidate,
          deliveryState: "sent",
          providerRequestId,
          resolutionSource: "automatic",
          evidence: {
            providerRequestId,
            positiveControl: "passed",
            source: "dropbox_metadata_search_sandra_request_id",
            observedAt: now.toISOString(),
          },
        });
        summary[result === "raced" ? "raced" : "sent"] += 1;
        continue;
      }
      const result = await ports.markOutcome({
        ...candidate,
        deliveryState: "send_unknown",
        safeErrorMessage: null,
      });
      summary[result === "raced" ? "raced" : "unknown"] += 1;
    } catch (error) {
      summary.errors += 1;
      ports.reportOutcomeError?.(error, candidate);
    }
  }
  return summary;
}

function shouldResolveUnknownSendAsFailed(input: {
  candidate: StuckEsignSend;
  now: Date;
  zeroEvidence: {
    consecutiveCompleteZeroCount: number;
    firstObservedAt: Date | null;
  };
}): boolean {
  if (input.candidate.deliveryState !== "send_unknown") return false;
  const unknownAgeMs = input.now.getTime() - input.candidate.updatedAt.getTime();
  if (unknownAgeMs < ESIGN_UNKNOWN_SEND_RESOLUTION_MIN_AGE_MS) return false;
  if (
    input.zeroEvidence.consecutiveCompleteZeroCount <
    ESIGN_UNKNOWN_SEND_ZERO_OBSERVATION_THRESHOLD
  ) {
    return false;
  }
  const firstObservedAt = input.zeroEvidence.firstObservedAt?.getTime();
  return (
    typeof firstObservedAt === "number" &&
    input.now.getTime() - firstObservedAt >=
      ESIGN_UNKNOWN_SEND_RESOLUTION_MIN_AGE_MS
  );
}
