const ESIGN_STUCK_SEND_MIN_AGE_MS = 15 * 60 * 1_000;
const ESIGN_STUCK_SEND_BATCH_SIZE = 10;

export type StuckEsignSend = Readonly<{
  id: string;
  orgId: string;
  testMode: boolean;
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
  markOutcome(input: StuckEsignSend & {
    deliveryState: "failed" | "send_unknown";
    safeErrorMessage: string | null;
  }): Promise<void>;
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
  const summary = { checked: 0, failed: 0, unknown: 0, deferred: 0, raced: 0 };
  for (const candidate of candidates) {
    if (ports.shouldContinue && !ports.shouldContinue()) break;
    summary.checked += 1;
    let lookup: Awaited<
      ReturnType<StuckSendReconciliationPorts["lookupProviderRequest"]>
    >;
    try {
      lookup = await ports.lookupProviderRequest(candidate);
    } catch {
      summary.deferred += 1;
      continue;
    }
    if (!lookup.complete) {
      summary.deferred += 1;
      continue;
    }
    if (lookup.providerRequestIds.length === 0) {
      try {
        await ports.markOutcome({
          ...candidate,
          deliveryState: "failed",
          safeErrorMessage: "STALE_NO_PROVIDER_REQUEST",
        });
        summary.failed += 1;
      } catch {
        summary.raced += 1;
      }
      continue;
    }
    try {
      await ports.markOutcome({
        ...candidate,
        deliveryState: "send_unknown",
        safeErrorMessage: null,
      });
      summary.unknown += 1;
    } catch {
      summary.raced += 1;
    }
  }
  return summary;
}
