// Plan rule 4 (+ H1): pure mapping from a pre-send / send result to the entry transition.

export type PreSendResult =
  | { kind: "queue_refused"; reason: string }
  | { kind: "capacity_concurrency" }
  | { kind: "capacity_daily" }
  | { kind: "number_busy" }
  | { kind: "gate"; reason: string }
  | { kind: "bland_not_configured" }
  | { kind: "ineligible"; reason: string }
  | { kind: "pre_send_error" }
  | { kind: "bland_http"; httpStatus: number }
  | { kind: "bland_timeout" }
  | { kind: "stranded_requested_expired" };

export type PreSendTransition = {
  entry: "queued" | "done" | "paused" | "calling";
  countsAttempt: boolean;
  requestStatus: "dispatch_rejected" | "dispatch_unknown";
  pauseReason?: string;
  endReason?: string;
  reason?: string;
};

const REQUEUE: PreSendTransition = { entry: "queued", countsAttempt: false, requestStatus: "dispatch_rejected" };
const UNKNOWN_SEND: PreSendTransition = { entry: "calling", countsAttempt: true, requestStatus: "dispatch_unknown" };

export function preSendTransition(result: PreSendResult): PreSendTransition {
  switch (result.kind) {
    case "ineligible":
      return { entry: "done", endReason: `blocked:${result.reason}`, countsAttempt: false, requestStatus: "dispatch_rejected" };
    case "bland_http": {
      const s = result.httpStatus;
      if (s >= 400 && s < 500 && s !== 408) {
        return { entry: "paused", pauseReason: "provider_refused", reason: `bland_http_${s}`, countsAttempt: false, requestStatus: "dispatch_rejected" };
      }
      return { ...UNKNOWN_SEND };
    }
    case "bland_timeout":
      return { ...UNKNOWN_SEND };
    default:
      return { ...REQUEUE };
  }
}
