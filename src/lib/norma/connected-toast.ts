import { NORMA_CONNECTED_OUTCOMES } from "./tone";

/**
 * "Norma reached a seller" toast, for the rep who asked for the call.
 *
 * Trigger: a COMPLETION with a connected outcome. Bland documents no real-time
 * "answered by a human" signal (see docs.bland.ai/api-v1/post/calls: in-call
 * events carry no answer flag; answered_by arrives with the post-call
 * webhook), so the earliest reliable moment is when the signed post-call
 * webhook completes the request. The toast therefore appears when the call
 * ends, not when the seller picks up.
 */
export type ConnectedRequestRow = {
  id: string;
  property_id: string;
  status: string;
  outcome: string | null;
  completed_at: string | null;
  requested_by: string | null;
};

/** How far before the page loaded a completion may be and still toast (covers a reload right after a call). */
export const CONNECTED_TOAST_LOOKBACK_MS = 2 * 60_000;

export function connectedToastSince(mountedAtMs: number): string {
  return new Date(mountedAtMs - CONNECTED_TOAST_LOOKBACK_MS).toISOString();
}

/**
 * Which rows deserve a toast now: this user's own requests, completed with a
 * connected outcome, not shown before, and finished since `sinceIso`.
 */
export function selectConnectedToasts(
  rows: readonly ConnectedRequestRow[],
  userId: string,
  notified: ReadonlySet<string>,
  sinceIso: string,
): ConnectedRequestRow[] {
  return rows.filter(
    (row) =>
      row.requested_by === userId &&
      row.status === "completed" &&
      (NORMA_CONNECTED_OUTCOMES as readonly string[]).includes(row.outcome ?? "") &&
      !!row.completed_at &&
      row.completed_at >= sinceIso &&
      !notified.has(row.id),
  );
}

/** Plain and factual: who, and which property. */
export function connectedToastText(sellerName: string | null | undefined, address: string | null | undefined): string {
  const who = sellerName?.trim() || "the seller";
  const where = address?.trim();
  return where ? `Norma reached ${who} — ${where}` : `Norma reached ${who}`;
}
