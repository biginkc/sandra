export type SoftphoneState = "closed" | "idle" | "live" | "held" | "wrap";

export type SoftphoneEvent =
  | { type: "open" }
  | { type: "close" }
  | { type: "call_started" }
  | { type: "call_live" }
  | { type: "hold" }
  | { type: "resume" }
  | { type: "hangup" }
  | { type: "wrap_complete" }
  | { type: "call_failed" };

/** Pure state policy shared by the UI and its regression tests. */
export function transitionSoftphoneState(
  state: SoftphoneState,
  event: SoftphoneEvent,
): SoftphoneState {
  switch (event.type) {
    case "open":
      return state === "closed" ? "idle" : state;
    case "close":
      return state === "idle" ? "closed" : state;
    case "call_started":
      return state === "idle" ? "idle" : state;
    case "call_live":
      return state === "idle" ? "live" : state;
    case "hold":
      return state === "live" ? "held" : state;
    case "resume":
      return state === "held" ? "live" : state;
    case "hangup":
      return state === "live" || state === "held" ? "wrap" : state;
    case "wrap_complete":
      return state === "wrap" ? "closed" : state;
    case "call_failed":
      return state === "live" || state === "held" ? "wrap" : state;
  }
}
