/**
 * Drip hand-off seam for routing v2 (BUILD-PLAN §14). PR-C owns the real
 * `route_reply_transition` DB function (retire current drip, enroll the new one, outbox,
 * latest-reply-wins). PR-B does NOT import PR-C code: it defines the interface here and
 * ships a no-op that records nothing and enrolls nothing. PR-C plugs its implementation in.
 */
export type V2DripName =
  | "Book appointment"
  | "Said they'd call"
  | "Price too high"
  | "Vacant land"
  | "Listed, not selling"
  | "Maybe later"
  | "Not interested"
  | "Asked who is texting"
  | "Confirmed owner";

export type V2DripTransitionRequest = {
  orgId: string;
  propertyId: string;
  inboundMessageId: string;
  /**
   * The drip to start, or null to only retire the current drip (PR-F: a picked time while
   * alert_on_time_only is on stops the Book appointment drip and starts nothing).
   */
  drip: V2DripName | null;
  /** The v2 road that chose this drip (audit). */
  road: string;
  /** Skip step 1 when our reply already said what step 1 says (who-is-texting). */
  skipFirstStep: boolean;
};

export type V2DripTransitionResult =
  | { kind: "enrolled"; enrollmentId: string }
  /** drip: null — the current drip (if any) was retired and nothing new was started. */
  | { kind: "stopped" }
  | { kind: "superseded" }
  | { kind: "not_available"; reason: "pr_c_not_merged" | string };

export interface V2DripTransition {
  transition(req: V2DripTransitionRequest): Promise<V2DripTransitionResult>;
}

/** Until PR-C lands: never enrolls, never retires anything. */
export const NOOP_DRIP_TRANSITION: V2DripTransition = {
  async transition() {
    return { kind: "not_available", reason: "pr_c_not_merged" };
  },
};
