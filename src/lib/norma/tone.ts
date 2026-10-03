import type { NormaOutcome } from "./types";

/**
 * How a Norma call is coloured wherever Sandra shows it (lead timeline pill,
 * status badge, call button).
 *   green   Norma actually spoke to a person (Bland answered_by = human, which
 *           is every outcome that needs a conversation to have happened).
 *   neutral nobody was reached (no answer, voicemail, busy) or the call is
 *           still in progress.
 *   amber   a human has to look (needs review, unknown, unconfirmed).
 */
export type NormaTone = "green" | "neutral" | "amber";

/** Outcomes that can only be produced by a conversation with a person. */
export const NORMA_CONNECTED_OUTCOMES = [
  "reached_no_callback",
  "callback_requested",
  "not_interested",
  "wrong_number",
] as const satisfies readonly NormaOutcome[];

export function isNormaConnectedOutcome(outcome: string | null | undefined): boolean {
  return typeof outcome === "string" && (NORMA_CONNECTED_OUTCOMES as readonly string[]).includes(outcome);
}

/** Tone of a finished call's outcome. A missing or unrecognised outcome needs a person. */
export function normaOutcomeTone(outcome: string | null | undefined): NormaTone {
  if (isNormaConnectedOutcome(outcome)) return "green";
  // A person looked and took it over: nothing is waiting, but nobody was reached either.
  if (outcome === "no_answer" || outcome === "reviewed") return "neutral";
  return "amber";
}

/** Tone of a request row: completed -> by outcome; waiting on a person -> amber; in progress -> neutral. */
export function normaRequestTone(status: string, outcome: string | null | undefined): NormaTone {
  if (status === "completed") return normaOutcomeTone(outcome);
  if (status === "needs_review" || status === "dispatch_unknown") return "amber";
  return "neutral";
}

// Same tokens the app already uses for "good" (my-leads queue rows) and for
// warnings (add-lead dialog), and the timeline's own muted pill for neutral.
export const NORMA_TONE_CLASSES: Record<NormaTone, string> = {
  green: "border-[#bbf7d0] bg-[#dcfce7] text-[#15803d] dark:border-green-900 dark:bg-green-950 dark:text-green-300",
  neutral: "border-border/80 bg-muted/80 text-muted-foreground",
  amber: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200",
};
