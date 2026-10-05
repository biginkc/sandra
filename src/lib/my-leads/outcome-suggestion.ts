export type CallReferenceFacts = {
  provider: string | null;
  callOutcome: string | null;
  talkSeconds: number | null;
};

export type SuggestedOutcome = "reached" | "no_answer" | "voicemail";

/**
 * Pre-guess for the post-call prompt from the linked call. `null` means no prefill. The rep can
 * always change it. An `unknown` call outcome is never guessed, whatever the talk time: the rep
 * chooses.
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
    default:
      return null;
  }
}
