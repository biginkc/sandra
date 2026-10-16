import { APPROVED_NUMBER_QUESTIONS, APPROVED_PAIN_QUESTIONS, CLOSER_LAB_FRAMING, CLOSER_LAB_QUESTIONS } from "./question-text";

/**
 * Every fact Sandra can propose, its chip label and the Jev question behind it. All question text
 * comes from ./question-text (Jarrad-approved verbatim, generated from ./approved). Labels are the
 * approved names where one exists (Closer Lab names) and otherwise the approved id, mechanically
 * spaced; nothing here is new display copy beyond that.
 *
 * kind:
 *   - "amount": code finds every dollar amount; Jev picks the candidate (or "none"); code copies it.
 *   - "date":   code finds and resolves every date phrase; Jev picks the candidate (or "none").
 *   - "turn":   Jev picks the transcript turn (T001...) that answers, or "none"; evidence is that turn.
 *   - "line_noul": Closer Lab's per-seller-turn yes/no scoring with its approved framing; a turn
 *     whose probability reaches `threshold` is a hit, and the best hit is the evidence.
 */
export type FactQuestionKind = "amount" | "date" | "turn" | "line_noul";

export type FactSlotDef = {
  /** The approved question id (a Closer Lab or Jarrad id). */
  id: string;
  /** The chip field key. */
  field: string;
  label: string;
  kind: FactQuestionKind;
  /** Verbatim approved wording; null = skipped. */
  text: string | null;
  /** line_noul only. */
  threshold?: number;
};

/** The approved 80% motivation-card threshold (Closer Lab OWNER-APPROVAL-MOTIVATION-CARD-2026-09-29). */
export const MOTIVATION_THRESHOLD = 0.8;
/** Closer Lab's objection acceptance threshold (OBJECTION_IDENTIFICATION_THRESHOLDS.partnerAcceptance / recallAcceptance, and the line identifier's default accept). */
export const OBJECTION_THRESHOLD = 0.9;
/** not_rushed has no threshold of its own in Closer Lab; it takes the objection-set acceptance. */
export const NOT_RUSHED_THRESHOLD = OBJECTION_THRESHOLD;

const spaced = (id: string) => {
  const s = id.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const closer = (id: string) => {
  const q = CLOSER_LAB_QUESTIONS.find((x) => x.id === id);
  if (!q) throw new Error(`closer lab question missing: ${id}`);
  return q;
};
const N = APPROVED_NUMBER_QUESTIONS;
const reused = new Set(["motivation", "not_rushed", "bad_experience"]);
const OBJECTION_IDS = CLOSER_LAB_QUESTIONS.map((q) => q.id).filter((id) => !reused.has(id));

export const FACT_SLOTS: readonly FactSlotDef[] = [
  { id: "asking_price", field: "asking_price", label: spaced("asking_price"), kind: "amount", text: N.asking_price },
  { id: "mortgage_owed", field: "mortgage", label: "Mortgage", kind: "amount", text: N.mortgage_owed },
  { id: "motivation", field: "motivation", label: closer("motivation").name, kind: "line_noul", text: closer("motivation").text, threshold: MOTIVATION_THRESHOLD },
  { id: "timeline", field: "timeline", label: spaced("timeline"), kind: "turn", text: N.timeline },
  { id: "next_step_with_date", field: "next_step", label: "Next step", kind: "date", text: N.next_step_with_date },
  { id: "behind_on_payments", field: "behind_on_payments", label: spaced("behind_on_payments"), kind: "turn", text: N.behind_on_payments },
  ...APPROVED_PAIN_QUESTIONS.map((p): FactSlotDef => ({ id: p.id, field: `pain_${p.id}`, label: spaced(p.id), kind: "turn", text: p.text })),
  { id: "not_rushed", field: "not_rushed", label: closer("not_rushed").name, kind: "line_noul", text: closer("not_rushed").text, threshold: NOT_RUSHED_THRESHOLD },
  ...OBJECTION_IDS.map((id): FactSlotDef => ({ id, field: `objection_${id}`, label: closer(id).name, kind: "line_noul", text: closer(id).text, threshold: OBJECTION_THRESHOLD })),
  { id: "bad_experience", field: "bad_experience", label: closer("bad_experience").name, kind: "line_noul", text: closer("bad_experience").text, threshold: OBJECTION_THRESHOLD },
];

/** `condition` has no question; it stays in the field list (lowest priority) for the allow-list. */
const CONDITION = { field: "condition", label: "Condition" } as const;

export const FACT_FIELDS = [...FACT_SLOTS.map((s) => s.field), CONDITION.field] as const;
export type FactField = string;
export const FACT_LABELS: Record<string, string> = {
  ...Object.fromEntries(FACT_SLOTS.map((s) => [s.field, s.label])),
  [CONDITION.field]: CONDITION.label,
};

export { CLOSER_LAB_FRAMING };
