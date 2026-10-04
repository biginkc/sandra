export type CallReferenceFacts = {
  provider: string | null;
  callOutcome: string | null;
  talkSeconds: number | null;
};

export type SuggestedOutcome = "reached" | "no_answer" | "voicemail";

/**
 * Pre-guess for the post-call prompt from the linked call. `null` means no prefill. The rep can
 * always change it. A Dialpad CTI projection writes `unknown` for a connected call, so a Dialpad
 * call with `unknown` and talk time counts as reached.
 */
export function suggestOutcome(ref: CallReferenceFacts): SuggestedOutcome | null {
  switch (ref.callOutcome) {
    case "voicemail":
      return "voicemail";
    case "connected_human":
      return "reached";
    case "no_answer":
    case "busy":
      return "no_answer";
    case "unknown":
      return ref.provider === "dialpad" && (ref.talkSeconds ?? 0) > 0 ? "reached" : null;
    default:
      return null;
  }
}
