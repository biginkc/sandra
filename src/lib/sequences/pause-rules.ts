/**
 * Pure classification of a triggering event into a pause decision.
 *
 * The DB-touching side (pausing the actual enrollments) lives elsewhere
 * — this function is just the "what should happen" policy, separated so
 * it's cheap to unit-test every rule without a Supabase round-trip.
 *
 * Rules (from the plan):
 *   - Any inbound reply → pause, resumable
 *   - Status → dead/closed → pause permanently (lead is done)
 *   - Status → offer_sent/under_contract → pause, resumable (human now
 *     owns the back-and-forth; sequence backs off so it doesn't step on
 *     an active acquisition conversation)
 *   - Any other status change → no pause
 *   - Consent opt_out → pause permanently (TCPA / decency)
 */

export type PauseEvent =
  | { type: "inbound_reply" }
  | { type: "status_change"; newStatus: string }
  | { type: "consent_revoked" };

export type PauseReason =
  | "inbound_reply"
  | "status_terminal"
  | "status_acquisition_active"
  | "consent_revoked";

export type PauseDecision = {
  shouldPause: boolean;
  reason: PauseReason | null;
  /** When true, the enrollment cannot be resumed (`status = 'opted_out'` or similar). */
  permanent: boolean;
};

const TERMINAL_STATUSES = new Set(["dead", "closed"]);
const ACQUISITION_STATUSES = new Set(["offer_sent", "under_contract"]);

export function evaluatePause(event: PauseEvent): PauseDecision {
  switch (event.type) {
    case "inbound_reply":
      return {
        shouldPause: true,
        reason: "inbound_reply",
        permanent: false,
      };
    case "consent_revoked":
      return {
        shouldPause: true,
        reason: "consent_revoked",
        permanent: true,
      };
    case "status_change":
      if (TERMINAL_STATUSES.has(event.newStatus)) {
        return {
          shouldPause: true,
          reason: "status_terminal",
          permanent: true,
        };
      }
      if (ACQUISITION_STATUSES.has(event.newStatus)) {
        return {
          shouldPause: true,
          reason: "status_acquisition_active",
          permanent: false,
        };
      }
      return { shouldPause: false, reason: null, permanent: false };
  }
}
