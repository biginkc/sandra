/**
 * Display reader for runs decided by the nine-question engine. Display only: it never decides anything.
 * The engine persists `engine: 'nine_questions'`, `answer` and `probabilities` on the classify step's detail;
 * every field is optional here, so old-engine runs (and half-written ones) simply read as null.
 */
import { NINE_ANSWER_LABELS, NINE_QUESTION_IDS, type NineAnswer } from "@/lib/sms-classification/nine-questions";

import type { TapeTag, TapeTone } from "./tape";
import type { PipelineRunStep } from "./types";

export type NineRunDecision = {
  answer: NineAnswer;
  probabilities: Partial<Record<string, number | null>> | null;
};

const ANSWERS: ReadonlySet<string> = new Set<string>([...NINE_QUESTION_IDS, "needs_person"]);

const NINE_TONE: Record<NineAnswer, TapeTone> = {
  open_to_selling: "hot",
  talked_price: "hot",
  asked_offer: "hot",
  named_price: "hot",
  asked_call: "hot",
  maybe_later: "later",
  asked_who: "who",
  confirmed_owner: "who",
  not_interested: "no",
  wrong_person: "no",
  already_sold: "no",
  tenant: "no",
  just_ok: "later",
  asked_stop: "stop",
  hostile: "stop",
  needs_person: "unclear",
};

/** The nine-question decision on a run's steps, or null for an old-engine run / anything unreadable. */
export function readNineDecision(steps: readonly PipelineRunStep[]): NineRunDecision | null {
  for (const s of steps) {
    const d = s.detail as Record<string, unknown> | null | undefined;
    if (!d || d.engine !== "nine_questions") continue;
    if (typeof d.answer !== "string" || !ANSWERS.has(d.answer)) continue;
    const p = d.probabilities;
    return {
      answer: d.answer as NineAnswer,
      probabilities: p && typeof p === "object" ? (p as Record<string, number | null>) : null,
    };
  }
  return null;
}

/** The tape tag for a nine-question run; null when the run was not decided by that engine. */
export function nineTapeTag(steps: readonly PipelineRunStep[]): TapeTag | null {
  const decision = readNineDecision(steps);
  return decision ? { label: NINE_ANSWER_LABELS[decision.answer], tone: NINE_TONE[decision.answer] } : null;
}
