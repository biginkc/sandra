// Shared contract between the direct-calling server actions and the browser
// transport. See .planning/direct-calling/PILOT-SPEC.md.

export type DirectCallStatus =
  | "browser_connecting"
  | "seller_dialing"
  | "connected"
  | "ending"
  | "ended"
  | "failed";

export const DIRECT_CALL_TERMINAL_STATUSES: ReadonlySet<DirectCallStatus> = new Set(["ended", "failed"]);

export type CallingConfig = { transport: "telnyx_direct" | "default" };

export type DirectActionResult<T> = { ok: true; data: T } | { ok: false; error: string; errorCode?: string };

export type DirectRtcToken = {
  /** Telnyx WebRTC login JWT for this operator's credential. */
  token: string;
  /** SIP username the server dials to reach this browser. */
  sipUsername: string;
};

export type StartDirectCallInput =
  | { kind: "lead"; propertyId: string; clientRequestId: string }
  | { kind: "manual"; phone: string; clientRequestId: string };

export type StartDirectCallResult = {
  directCallId: string;
  /** Telnyx call_control_id of the leg the server dialed to this browser. */
  browserLegId: string;
  /** Header name/value the browser leg carries, for pre-answer matching. */
  correlationHeader: { name: "X-Sandra-Direct-Call-Id"; value: string };
  /**
   * Sealed call identity for wrap-up (the same capability the Jitter path mints),
   * bound to this call id, operator, destination and purpose. Absent only when the
   * server has no signing key and the call is not an internal training call.
   */
  callCapability?: string;
};

export type DirectCallStatusView = {
  directCallId: string;
  status: DirectCallStatus;
  connectedAt: string | null;
  endedAt: string | null;
  hangupCause: string | null;
  failureReason: string | null;
  /**
   * True while any leg (or orphan leg) of this call is not yet confirmed ended by the provider.
   * A terminal status with cleanupPending=true is NOT authoritative: the browser keeps polling.
   */
  cleanupPending: boolean;
};

export type DirectCallControl =
  | { action: "hangup" }
  | { action: "dtmf"; digit: "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "*" | "#" };

/*
 * Server actions (implemented in ./actions.ts, "use server"):
 *   getCallingConfigForCurrentUser(): Promise<CallingConfig>
 *   getDirectRtcToken(): Promise<DirectActionResult<DirectRtcToken>>
 *   startDirectCall(input: StartDirectCallInput): Promise<DirectActionResult<StartDirectCallResult>>
 *   getDirectCallStatus(directCallId: string): Promise<DirectActionResult<DirectCallStatusView>>
 *   controlDirectCall(directCallId: string, control: DirectCallControl): Promise<DirectActionResult<{ accepted: true }>>
 */
