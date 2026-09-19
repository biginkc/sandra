export type AcquisitionHistoryFact = {
  id: string;
  at: string;
  actorId: string | null;
} & (
  | {
      kind: "attempt";
      source: string;
      attemptKind: string;
      outcome: string | null;
      /** Optional enrichment supplied by a rep-SMS orchestration read. */
      followUpStatus?:
        | "required"
        | "draft"
        | "claimed"
        | "sending"
        | "accepted"
        | "delivered"
        | "failed_not_dispatched"
        | "delivery_failed"
        | "blocked"
        | "unknown"
        | "voided"
        | "exception_closed"
        | null;
      followUpObligationId?: string | null;
      followUpMessage?: string | null;
      followUpComposition?: Record<string, unknown> | null;
      followUpBlockedReason?: string | null;
      note: string | null;
      recordingUrl: string | null;
      callActivityId: string | null;
    }
  | {
      kind: "offer";
      amountCents: string;
      method: string;
      followUpAt: string;
      outcome: string;
      outcomeAt: string | null;
    }
);
export type AcquisitionHistoryCursor = {
  at: string;
  kind: "attempt" | "offer";
  id: string;
};
export type AcquisitionHistoryPage = {
  rows: AcquisitionHistoryFact[];
  hasMore: boolean;
  cursor: AcquisitionHistoryCursor | null;
};
export type AcquisitionHistoryResult =
  | { ok: true; page: AcquisitionHistoryPage }
  | { ok: false; message: string };
export function safeHistoryRecording(value: string | null) {
  try {
    if (!value) return null;
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function historyMoney(cents: string) {
  if (!/^\d+$/.test(cents)) return "Amount unavailable";
  const n = BigInt(cents);
  return `$${(n / BigInt(100)).toLocaleString("en-US")}.${(n % BigInt(100)).toString().padStart(2, "0")}`;
}
export function mergeAcquisitionHistory(
  current: AcquisitionHistoryFact[],
  next: AcquisitionHistoryFact[],
) {
  return [
    ...new Map(
      [...current, ...next].map((row) => [`${row.kind}:${row.id}`, row]),
    ).values(),
  ];
}
