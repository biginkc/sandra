import type { NormaStoredOutcome } from "./types";

/** Plain labels for each outcome; shared by the Slack post and the lead UI. */
export const NORMA_OUTCOME_LABELS: Record<NormaStoredOutcome, string> = {
  no_answer: "No answer",
  callback_requested: "Callback requested",
  reached_no_callback: "Reached the seller, no callback requested",
  not_interested: "Seller not interested",
  wrong_number: "Wrong number",
  unknown: "Needs review",
  reviewed: "Reviewed by a person",
};

export function normaOutcomeLabel(outcome: string | null | undefined): string {
  return outcome && Object.hasOwn(NORMA_OUTCOME_LABELS, outcome)
    ? NORMA_OUTCOME_LABELS[outcome as NormaStoredOutcome]
    : "Needs review";
}
