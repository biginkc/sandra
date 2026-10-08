/**
 * Keys an owner may map to an approved template for automatic replies.
 * Mirrors the `auto_reply_templates_outcome_check` constraint: new_lead (PLAN
 * D5), opted_out and dnc are never answered automatically. `wrong_number` is
 * mappable because the responder suppresses the number whenever that text goes
 * out. `hostile` is not a Jev label: it is detected from the seller's wording
 * (see `src/lib/ai-responder/hostile.ts`). Labels are UI captions only; no
 * reply text lives here.
 */
export const AUTO_REPLY_OUTCOMES = [
  { outcome: "nurture", label: "Nurture" },
  { outcome: "not_interested", label: "Not interested" },
  {
    outcome: "wrong_number",
    label: "Wrong number",
    note: "When this reply is sent, all future texts to the number stop.",
  },
  {
    outcome: "hostile",
    label: "Hostile",
    note: "Hostile wording always stops all future texts to the number, with or without a reply.",
  },
] as const;

/** Caption shown under a row; only some rows have one. */
export function autoReplyNote(outcome: AutoReplyOutcome): string | null {
  const row = AUTO_REPLY_OUTCOMES.find((o) => o.outcome === outcome);
  return row && "note" in row ? row.note : null;
}

export type AutoReplyOutcome = (typeof AUTO_REPLY_OUTCOMES)[number]["outcome"];

export type AutoReplyMapping = {
  id: string;
  outcome: AutoReplyOutcome;
  templateId: string;
  active: boolean;
};

export type AutoReplySettings = {
  orgId: string;
  mappings: AutoReplyMapping[];
  /** Per-label automation switch (jev_outcome_thresholds.automation_enabled); absent = unknown. */
  labelAutomation: Partial<Record<AutoReplyOutcome, boolean>>;
};
