/**
 * Whether a CASS job was intentionally left queued for a manual paid-run
 * confirmation. Kept client-safe for the Jobs screen.
 */
export function isAwaitingManualStart(resultSummary: unknown): boolean {
  if (!resultSummary || typeof resultSummary !== "object") return false;
  return (
    (resultSummary as { awaiting_manual_start?: unknown })
      .awaiting_manual_start === true
  );
}
