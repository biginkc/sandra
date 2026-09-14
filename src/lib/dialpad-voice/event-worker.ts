import "server-only";
import { InvalidDialpadCallEvent, normalizeDialpadCallEvent, type DialpadCallEvent } from "./call-event";

export interface ClaimedVoiceEvent {
  id: string;
  orgId: string;
  leaseToken: string;
  attemptCount: number;
  payload: unknown;
  webhookSourceId?: string|null;
}
export class DialpadEvidenceRejected extends Error {
  constructor() { super("Dialpad evidence rejected"); }
}
export interface VoiceEventWorkerStore {
  claim(): Promise<ClaimedVoiceEvent[]>;
  authorizeEvent(receipt:ClaimedVoiceEvent,event:DialpadCallEvent):Promise<void>;
  recordEvidence(intentId: string, receiptId: string): Promise<void>;
  enqueueRecordings(receipt: ClaimedVoiceEvent, event: DialpadCallEvent): Promise<void>;
  ingestInsights(receipt: ClaimedVoiceEvent, event: DialpadCallEvent): Promise<void>;
  /** Must compare the current lease token; false means another worker owns it. */
  finish(receipt: ClaimedVoiceEvent, result: {
    status: "processed" | "retry" | "quarantined" | "failed";
    errorCode: string | null;
    retryAt: string | null;
  }): Promise<boolean>;
}

/** Claims and effects must be independently idempotent: a crash between an
 * effect and its receipt update causes replay. No in-memory dedupe is sufficient.
 * Provider-neutral SQL evidence owns attribution; this worker never credits a rep.
 */
export async function processDialpadVoiceEvents(options: {
  store: VoiceEventWorkerStore;
  orgId: string;

  now?: () => number;
}) {
  const receipts = await options.store.claim();
  const counts = { processed: 0, retry: 0, quarantined: 0, failed: 0, leaseLost: 0 };
  for (const receipt of receipts) {
    let result: Parameters<VoiceEventWorkerStore["finish"]>[1];
    try {
      if (receipt.orgId !== options.orgId) throw new DialpadEvidenceRejected();
      const event = normalizeDialpadCallEvent(receipt.payload);
      if (event.targetType?.trim().toLowerCase() !== "user") {
        throw new DialpadEvidenceRejected();
      }
      await options.store.authorizeEvent(receipt,event);
      if (event.direction === "outbound" && event.intentId &&
        ["calling", "ringing", "connected", "hangup", "missed", "recording", "call_transcription"].includes(event.state)) {
        await options.store.recordEvidence(event.intentId, receipt.id);
      }
      // Only a trusted configured intent may enqueue artifacts.
      // The store must independently resolve any intent link from persisted truth.
      await options.store.enqueueRecordings(receipt, event);
      if (event.state === "call_transcription" || event.state === "recap_summary") {
        await options.store.ingestInsights(receipt, event);
      }
      result = { status: "processed", errorCode: null, retryAt: null };
    } catch (error) {
      if (error instanceof InvalidDialpadCallEvent || error instanceof DialpadEvidenceRejected) {
        result = { status: "quarantined", errorCode: "evidence_requires_reconciliation", retryAt: null };
      } else if (receipt.attemptCount >= 8) {
        result = { status: "failed", errorCode: "processing_failed", retryAt: null };
      } else {
        const seconds = Math.min(3600, 15 * 2 ** Math.max(0, receipt.attemptCount - 1));
        result = { status: "retry", errorCode: "processing_unavailable", retryAt: new Date((options.now ?? Date.now)() + seconds * 1000).toISOString() };
      }
    }
    // If this write fails, leave the lease to expire and replay; do not fabricate
    // a successful completion or run a second effect in this invocation.
    if (await options.store.finish(receipt, result)) counts[result.status]++;
    else counts.leaseLost++;
  }
  return counts;
}
