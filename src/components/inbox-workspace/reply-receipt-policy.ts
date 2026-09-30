import {
  INBOX_REPLY_TERMINAL_RECEIPT_STATES,
  type InboxReplyStatus,
} from "@/lib/inbox/reply-api-contract";

/** Operational bound: keep checking while the durable receipt is making progress. */
export const MAX_POLL_DURATION_MS = 120_000;

/** Shared receipt polling backoff. The last delay is reused until the bound. */
export const RECEIPT_POLL_BACKOFF_MS = [
  500,
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  30_000,
] as const;

export type ReceiptClassification = "in_flight" | "terminal" | "not_confirmed";

export type ReceiptPollTracker = {
  fingerprint?: string;
  unchangedSince: number;
};

export type ReceiptProgress = {
  completed: number;
  total: number;
};

export type ReceiptClassificationResult = {
  classification: ReceiptClassification;
  fingerprint: string;
  progress: ReceiptProgress;
  unchangedSince: number;
};

export function isTerminalReceiptState(
  state: InboxReplyStatus["receipts"][number]["state"],
): boolean {
  return INBOX_REPLY_TERMINAL_RECEIPT_STATES.includes(
    state as (typeof INBOX_REPLY_TERMINAL_RECEIPT_STATES)[number],
  );
}

export function isTerminalReceiptStatus(status: InboxReplyStatus): boolean {
  return (
    status.receipts.length > 0 &&
    status.receipts.every((receipt) => isTerminalReceiptState(receipt.state))
  );
}

export function receiptProgress(status: InboxReplyStatus): ReceiptProgress {
  return {
    completed: status.receipts.filter((receipt) =>
      isTerminalReceiptState(receipt.state),
    ).length,
    total: status.receipts.length,
  };
}

/**
 * Fingerprint only durable receipt progress. Ordering is normalized so a
 * server-side row reorder does not reset the no-change clock.
 */
export function receiptProgressFingerprint(status: InboxReplyStatus): string {
  return JSON.stringify({
    dispatchComplete: status.dispatchComplete,
    receipts: [...status.receipts]
      .map((receipt) => ({
        itemId: receipt.itemId,
        attemptId: receipt.attemptId,
        version: receipt.version,
        state: receipt.state,
        reason: receipt.reason,
      }))
      .sort((left, right) => left.itemId.localeCompare(right.itemId)),
  });
}

export function classifyReceipt(
  status: InboxReplyStatus,
  tracker: ReceiptPollTracker,
  now = Date.now(),
): ReceiptClassificationResult {
  const fingerprint = receiptProgressFingerprint(status);
  const unchangedSince =
    tracker.fingerprint === undefined || tracker.fingerprint !== fingerprint
      ? now
      : tracker.unchangedSince;
  const progress = receiptProgress(status);

  if (isTerminalReceiptStatus(status)) {
    return { classification: "terminal", fingerprint, progress, unchangedSince };
  }

  if (now - unchangedSince >= MAX_POLL_DURATION_MS) {
    return {
      classification: "not_confirmed",
      fingerprint,
      progress,
      unchangedSince,
    };
  }

  return { classification: "in_flight", fingerprint, progress, unchangedSince };
}

export function receiptProgressCopy(progress: ReceiptProgress): string {
  const noun = progress.total === 1 ? "recipient has" : "recipients have";
  return `${progress.completed} of ${progress.total} ${noun} a terminal receipt. We’ll keep checking the server; do not resend this reply.`;
}

export function receiptPollDelay(
  attempt: number,
  unchangedSince: number,
  now = Date.now(),
): number | null {
  const remaining = MAX_POLL_DURATION_MS - (now - unchangedSince);
  if (remaining <= 0) return null;
  return Math.min(
    RECEIPT_POLL_BACKOFF_MS[Math.min(attempt, RECEIPT_POLL_BACKOFF_MS.length - 1)],
    remaining,
  );
}
