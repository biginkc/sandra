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

export type DirectActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      errorCode?: string;
      /**
       * startDirectCall only. `false` = the server refused BEFORE reserving anything (not enabled, invalid
       * request, operator busy, prepare refused and its reservation discarded): no call, Dial or cleanup
       * obligation exists for the request id. Anything else (`true`, absent) means a reservation exists or
       * may exist, so the browser must reconcile by request id and wait for terminal + cleanupPending:false.
       */
      reserved?: boolean;
    };

export type DirectRtcToken = {
  /** Telnyx WebRTC login JWT for this operator's credential. */
  token: string;
  /** SIP username the server dials to reach this browser. */
  sipUsername: string;
};

export type StartDirectCallInput =
  | { kind: "lead"; propertyId: string; clientRequestId: string }
  | { kind: "manual"; phone: string; clientRequestId: string };

/** Display/identity fields of the server-prepared call target (same shape as the dialer's SoftphoneTarget). */
export type DirectCallTarget = {
  propertyId: string | null;
  contactId: string | null;
  phoneE164: string;
  maskedPhone: string;
  name: string;
  address: string | null;
  state: string | null;
  startedAt: string;
  repName?: string | null;
};

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
  /**
   * The target the server prepared (and, for a lead, paused enrollments for) after its busy check.
   * Absent only on an idempotent replay of an in-flight request id.
   */
  target?: DirectCallTarget;
  /** Presence admission must be acknowledged before the browser answers its inbound leg. */
  browserWatchdog?: { url: string; token: string };
};

export type DirectCallStatusView = {
  directCallId: string;
  status: DirectCallStatus;
  connectedAt: string | null;
  endedAt: string | null;
  hangupCause: string | null;
  failureReason: string | null;
  /**
   * True while any cleanup obligation of this call (a leg not yet confirmed ended, or a seller Dial
   * whose outcome is still unresolved) is outstanding. A terminal status with cleanupPending=true is
   * NOT authoritative: the browser keeps polling.
   */
  cleanupPending: boolean;
};

export type DirectCallControl =
  | { action: "hangup" }
  | { action: "dtmf"; digit: "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "*" | "#" };

/** Result of cancelling a request by its client request id. */
export type CancelDirectCallResult = {
  /** The call that exists for the request id, or null when none did (a tombstone now blocks it). */
  directCallId: string | null;
  /** True when no call existed and a tombstone was recorded, so a late start dials nothing. */
  tombstoned: boolean;
};

/*
 * Server actions (implemented in ./actions.ts, "use server"):
 *   getCallingConfigForCurrentUser(): Promise<CallingConfig>
 *   getDirectRtcToken(): Promise<DirectActionResult<DirectRtcToken>>
 *   startDirectCall(input: StartDirectCallInput): Promise<DirectActionResult<StartDirectCallResult>>
 *   getDirectCallStatus(directCallId: string): Promise<DirectActionResult<DirectCallStatusView>>
 *   controlDirectCall(directCallId: string, control: DirectCallControl): Promise<DirectActionResult<{ accepted: true }>>
 *   cancelDirectCallByRequest(clientRequestId: string): Promise<DirectActionResult<CancelDirectCallResult>>
 *     call exists for the request id -> explicit hangup path; none -> terminal tombstone (failed,
 *     cancelled_before_start) so a late startDirectCall with that id returns errorCode "cancelled".
 *   getDirectCallStatusByRequest(clientRequestId: string): Promise<DirectActionResult<DirectCallStatusView>>
 *     errorCode "not_found" when no call (and no tombstone) exists for the request id.
 */
