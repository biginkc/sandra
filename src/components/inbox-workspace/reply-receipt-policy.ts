import type {
  InboxReplyReceipt,
  InboxReplyStatus,
  PreparedInboxReplyItem,
} from "@/lib/inbox/reply-api-contract";

/** Operational bound from notes/research-reply-receipt-states.md §(b)/(e). */
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

type ReceiptState = InboxReplyReceipt["state"];

/**
 * This is deliberately not INBOX_REPLY_TERMINAL_RECEIPT_STATES. The server's
 * dispatch terminal set is unsafe for UI polling: report §(b) says blocked is
 * final for a recipient, while provider_accepted can still receive a callback.
 */
const FINAL_RECEIPT_STATES: readonly ReceiptState[] = [
  "delivered",
  "delivery_failed",
  "blocked",
  "confirmed_not_submitted",
  "rejected_unsent",
];

const IN_FLIGHT_RECEIPT_STATES: readonly ReceiptState[] = [
  "pending",
  "dispatch_started",
  "provider_accepted",
];

export type ReceiptClassification = "in_flight" | "terminal" | "not_confirmed";
export type ReceiptNotConfirmedReason = "server" | "timeout";
export type ReceiptRowClass =
  | "sending"
  | "delivered"
  | "failed"
  | "blocked"
  | "not_confirmed_server"
  | "not_confirmed_timeout"
  | "excluded";

export type ReceiptPollTracker = {
  fingerprint?: string;
  unchangedSince: number;
};

export type ReceiptProgress = {
  completed: number;
  total: number;
};

export type ReceiptRowDecision = {
  label: string;
  className: ReceiptRowClass;
  keepPolling: boolean;
  canResend: false;
  statusLabel?: string;
  reason?: string;
};

export type ReceiptItemView = ReceiptRowDecision & {
  itemId: string;
  receipt?: InboxReplyReceipt;
};

export type ReceiptRollupCounts = {
  delivered: number;
  sending: number;
  failed: number;
  blocked: number;
  notConfirmedServer: number;
  notConfirmedTimeout: number;
  excluded: number;
};

export type ReceiptRollup = {
  counts: ReceiptRollupCounts;
  headline: "Sending" | "Delivered" | "Not sent" | "Some not sent" | "Some not confirmed, do not resend" | "Send result not confirmed" | "No eligible recipients";
  keepPolling: boolean;
  hasServerNotConfirmed: boolean;
  hasTimeoutNotConfirmed: boolean;
  rows: readonly ReceiptItemView[];
};

export type ReceiptBadgeTone = "success" | "pending" | "blocked" | "failed" | "uncertain" | "mixed" | "neutral";

export type ReceiptBadge = {
  label: string;
  tone: ReceiptBadgeTone;
};

export type ReceiptClassificationResult = {
  classification: ReceiptClassification;
  notConfirmedReason?: ReceiptNotConfirmedReason;
  fingerprint: string;
  progress: ReceiptProgress;
  rollup: ReceiptRollup;
  unchangedSince: number;
};

export function isTerminalReceiptState(state: ReceiptState): boolean {
  return FINAL_RECEIPT_STATES.includes(state);
}

function isInFlightReceiptState(state: ReceiptState): boolean {
  return IN_FLIGHT_RECEIPT_STATES.includes(state);
}

function humanizeReason(reason: string): string {
  const words = reason.trim().replace(/[\s_-]+/g, " ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown reason";
}

export function receiptReasonCopy(reason: string | null): string | undefined {
  return reason ? humanizeReason(reason) : undefined;
}

/**
 * The nine-state row truth table is copied from report §(e). `timedOut` is a
 * client observation, never a server state; it only changes the three states
 * named in report §(b)'s no-change fallback rule.
 */
export function classifyReceiptRow(
  receipt: InboxReplyReceipt,
  timedOut = false,
): ReceiptRowDecision {
  const reason = receiptReasonCopy(receipt.reason);

  switch (receipt.state) {
    case "pending":
      return timedOut
        ? { label: "Could not confirm, may still send", className: "not_confirmed_timeout", keepPolling: false, canResend: false }
        : { label: "Sending", className: "sending", keepPolling: true, canResend: false };
    case "dispatch_started":
      return timedOut
        ? { label: "Could not confirm, may still send", className: "not_confirmed_timeout", keepPolling: false, canResend: false }
        : { label: "Sending", className: "sending", keepPolling: true, canResend: false };
    case "provider_accepted":
      return timedOut
? { label: "Accepted by carrier, delivery not confirmed", className: "not_confirmed_timeout", keepPolling: false, canResend: false }
: { label: "Accepted, delivery pending", className: "sending", keepPolling: true, canResend: false };
    case "delivered":
      return { label: "Delivered", className: "delivered", keepPolling: false, canResend: false };
    case "delivery_failed":
      return { label: "Delivery failed", className: "failed", keepPolling: false, canResend: false, reason };
    case "uncertain":
      return {
        label: "Not confirmed, may or may not have sent. Do not resend",
        className: "not_confirmed_server",
        keepPolling: false,
        canResend: false,
        reason,
      };
    case "blocked":
      return {
        label: reason ? `Not sent: ${reason}` : "Not sent",
        className: "blocked",
        keepPolling: false,
        canResend: false,
        statusLabel: "Blocked",
      };
    case "confirmed_not_submitted":
      return { label: "Not sent", className: "failed", keepPolling: false, canResend: false, reason };
    case "rejected_unsent":
      return { label: "Not sent (rejected)", className: "failed", keepPolling: false, canResend: false, reason };
  }
}

function excludedItemView(item: PreparedInboxReplyItem): ReceiptItemView {
  return {
    itemId: item.id,
    label: `Excluded: ${humanizeReason(item.exclusion ?? "unknown")}`,
    className: "excluded",
    keepPolling: false,
    canResend: false,
  };
}

function missingReceiptView(item: PreparedInboxReplyItem): ReceiptItemView {
  return {
    itemId: item.id,
    label: "Send result not confirmed",
    className: "not_confirmed_server",
    keepPolling: false,
    canResend: false,
  };
}

/** Render the frozen items, keeping excluded-at-review items out of receipt counts. */
export function receiptItemViews(status: InboxReplyStatus, timedOut = false): ReceiptItemView[] {
  const receipts = new Map(status.receipts.map(receipt => [receipt.itemId, receipt]));
  const rows = status.items.map(item => {
    if (item.exclusion !== null) return excludedItemView(item);
    const receipt = receipts.get(item.id);
    return receipt
      ? { itemId: item.id, receipt, ...classifyReceiptRow(receipt, timedOut) }
      : missingReceiptView(item);
  });
  const itemIds = new Set(status.items.map(item => item.id));
  for (const receipt of status.receipts) {
    if (!itemIds.has(receipt.itemId)) rows.push({ itemId: receipt.itemId, receipt, ...classifyReceiptRow(receipt, timedOut) });
  }
  return rows;
}

/**
 * Rollup precedence and count groups are report §(c). `dispatchComplete` is
 * intentionally absent: provider callbacks and blocked rows make it unsafe as
 * a user-facing completion signal.
 */
export function receiptRollup(status: InboxReplyStatus, timedOut = false): ReceiptRollup {
  const rows = receiptItemViews(status, timedOut);
  const counts: ReceiptRollupCounts = {
    delivered: 0,
    sending: 0,
    failed: 0,
    blocked: 0,
    notConfirmedServer: 0,
    notConfirmedTimeout: 0,
    excluded: 0,
  };
  for (const row of rows) {
    switch (row.className) {
      case "delivered": counts.delivered += 1; break;
      case "sending": counts.sending += 1; break;
      case "failed": counts.failed += 1; break;
      case "blocked": counts.blocked += 1; break;
      case "not_confirmed_server": counts.notConfirmedServer += 1; break;
      case "not_confirmed_timeout": counts.notConfirmedTimeout += 1; break;
      case "excluded": counts.excluded += 1; break;
    }
  }
  const receiptCount = rows.length - counts.excluded;
  const hasServerNotConfirmed = counts.notConfirmedServer > 0;
  const hasTimeoutNotConfirmed = counts.notConfirmedTimeout > 0;
  const keepPolling = rows.some(row => row.keepPolling);
  const headline = hasServerNotConfirmed
    ? receiptCount === 1 ? "Send result not confirmed" : "Some not confirmed, do not resend"
    : counts.sending > 0
      ? "Sending"
      : hasTimeoutNotConfirmed
        ? "Send result not confirmed"
        : counts.blocked + counts.failed > 0
          ? receiptCount === 1 ? "Not sent" : "Some not sent"
            : counts.delivered > 0
              ? "Delivered"
              : "No eligible recipients";
  return { counts, headline, keepPolling, hasServerNotConfirmed, hasTimeoutNotConfirmed, rows };
}

/**
 * The composer badge is a policy presentation of the operation rollup, not a
 * second receipt-state classifier. Keep these outcomes explicit so a terminal
 * unsent receipt can never inherit a green `sent` phase label.
 */
export function receiptRollupBadge(rollup: ReceiptRollup): ReceiptBadge {
  const { counts } = rollup;
  const notConfirmed = counts.notConfirmedServer + counts.notConfirmedTimeout;
  const receiptCount = counts.delivered + counts.sending + counts.failed + counts.blocked + notConfirmed;

  if (receiptCount === 0) return { label: "No recipients", tone: "neutral" };
  if (counts.delivered === receiptCount) return { label: "Delivered", tone: "success" };
  if (counts.sending === receiptCount) return { label: "Sending", tone: "pending" };
  if (counts.blocked === receiptCount) return { label: "Blocked", tone: "blocked" };
  if (counts.failed === receiptCount) return { label: "Failed", tone: "failed" };
  if (notConfirmed === receiptCount) return { label: "Not confirmed", tone: "uncertain" };
  return { label: "Mixed", tone: "mixed" };
}

export function isTerminalReceiptStatus(status: InboxReplyStatus): boolean {
  const rollup = receiptRollup(status);
  return !rollup.keepPolling && !rollup.hasServerNotConfirmed && !rollup.hasTimeoutNotConfirmed;
}

export function receiptProgress(status: InboxReplyStatus): ReceiptProgress {
  return {
    completed: status.receipts.filter(receipt => isTerminalReceiptState(receipt.state)).length,
    total: status.receipts.length,
  };
}

/**
 * Fingerprint fields are the report §(b) contract: itemId, attemptId, version,
 * state, reason, plus dispatchComplete. Receipt order is not progress.
 */
export function receiptProgressFingerprint(status: InboxReplyStatus): string {
  return JSON.stringify({
    dispatchComplete: status.dispatchComplete,
    receipts: [...status.receipts]
      .map(receipt => ({
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
  const unchangedSince = tracker.fingerprint === undefined || tracker.fingerprint !== fingerprint
    ? now
    : tracker.unchangedSince;
  const progress = receiptProgress(status);
  const timedOut = now - unchangedSince >= MAX_POLL_DURATION_MS && status.receipts.some(receipt => isInFlightReceiptState(receipt.state));
  const rollup = receiptRollup(status, timedOut);

  if (isTerminalReceiptStatus(status)) {
    return { classification: "terminal", fingerprint, progress, rollup, unchangedSince };
  }
  if (timedOut) {
    return { classification: "not_confirmed", notConfirmedReason: rollup.hasServerNotConfirmed ? "server" : "timeout", fingerprint, progress, rollup, unchangedSince };
  }
  if (rollup.keepPolling) {
    return { classification: "in_flight", fingerprint, progress, rollup, unchangedSince };
  }
  if (rollup.hasServerNotConfirmed) {
    return { classification: "not_confirmed", notConfirmedReason: "server", fingerprint, progress, rollup, unchangedSince };
  }
  return { classification: "not_confirmed", notConfirmedReason: "server", fingerprint, progress, rollup, unchangedSince };
}

export function receiptRollupCopy(rollup: ReceiptRollup): string {
  const parts: string[] = [];
  if (rollup.counts.delivered > 0) parts.push(`${rollup.counts.delivered} delivered`);
  if (rollup.counts.sending > 0) parts.push(`${rollup.counts.sending} sending`);
  if (rollup.counts.notConfirmedServer + rollup.counts.notConfirmedTimeout > 0) parts.push(`${rollup.counts.notConfirmedServer + rollup.counts.notConfirmedTimeout} not confirmed`);
  if (rollup.counts.blocked + rollup.counts.failed > 0) parts.push(`${rollup.counts.blocked + rollup.counts.failed} not sent`);
  if (rollup.counts.excluded > 0) parts.push(`${rollup.counts.excluded} excluded`);
  if (rollup.hasServerNotConfirmed) return `${parts.join(", ")}. Do not resend this reply.`;
  if (rollup.hasTimeoutNotConfirmed) return `${parts.join(", ")}. We could not confirm the result; it may still send. Do not resend this reply.`;
  if (rollup.keepPolling) return `${parts.join(", ")}. We’ll keep checking the server; do not resend this reply.`;
  if (rollup.headline === "Delivered") return "The server recorded delivery for every recipient.";
  if (rollup.headline === "No eligible recipients") return "No eligible recipients have a receipt.";
  return `${parts.join(", ")}. Do not resend this reply.`;
}

/** Kept for callers that only have the old progress shape. */
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
