/**
 * Keys an owner may map to an approved template for automatic replies.
 * Mirrors the `auto_reply_templates_outcome_check` constraint: new_lead (PLAN
 * D5), opted_out and dnc are never answered automatically. `number_source` is the
 * reply to a seller asking how we got their number (sent instead of the
 * nurture / not-interested template for that message). `wrong_number` is
 * mappable: its reply applies the wrong_number disposition for that property
 * only (no phone-wide suppression). `hostile` is not a Jev label: it is detected from the seller's wording
 * (see `src/lib/ai-responder/hostile.ts`) and its reply is only ever sent by a
 * person confirming do-not-contact. Labels are UI captions only; no
 * reply text lives here.
 */
export const AUTO_REPLY_OUTCOMES = [
  { outcome: "nurture", label: "Nurture" },
  { outcome: "not_interested", label: "Not interested" },
  {
    outcome: "wrong_number",
    label: "Wrong number",
    note: "Sent automatically for a clear wrong number. Closes this property only; the phone number itself is not blocked.",
  },
  {
    outcome: "hostile",
    label: "Hostile",
    note: "Never sent automatically. Sent only when a person clicks Confirm do-not-contact on a hostile hold, right before the number is blocked.",
  },
  {
    outcome: "number_source",
    label: "Asked where we got their number",
    note: "Sent instead of the Nurture / Not interested reply when the seller asks how we got their number, then held for a person to see their answer. If it cannot be sent, no other reply goes out and a person is told. Never sent for a stop request, a legal demand, a wrong number or a new lead; nobody is blocked automatically.",
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
