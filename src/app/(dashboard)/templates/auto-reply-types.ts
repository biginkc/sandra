/**
 * Keys an owner may map to an approved template for automatic replies.
 * Mirrors the `auto_reply_templates_outcome_check` constraint: new_lead (PLAN
 * D5), opted_out, dnc and wrong_number are never answered automatically.
 * `number_source` is not a Jev label: it is the reply to a seller asking how
 * we got their number, sent instead of the nurture / not-interested template
 * for that message. Labels are UI captions only; no reply text lives here.
 */
export const AUTO_REPLY_OUTCOMES = [
  { outcome: "nurture", label: "Nurture" },
  { outcome: "not_interested", label: "Not interested" },
  {
    outcome: "number_source",
    label: "Asked where we got their number",
    note: "Sent instead of the Nurture / Not interested reply when the seller asks how we got their number. It is never sent for a stop request, a legal demand or a wrong number, and it does not block anyone: if they then say to take them off, that goes to the usual opt-out review.",
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
