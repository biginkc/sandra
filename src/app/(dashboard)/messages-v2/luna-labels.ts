/** Plain labels for Luna's outcomes (display only). */
export const LUNA_OUTCOME_LABELS: Record<string, string> = {
  new_lead: "New lead",
  nurture: "Nurture",
  not_interested: "Not interested",
  wrong_number: "Wrong number",
  opted_out: "Opted out",
  dnc: "DNC",
};

export const lunaOutcomeLabel = (outcome: string): string =>
  LUNA_OUTCOME_LABELS[outcome] ?? outcome;

/** Opt-out outcomes are never applied from the card; they go through the human confirm flow. */
export const LUNA_HUMAN_CONFIRM_OUTCOMES: ReadonlySet<string> = new Set(["opted_out", "dnc"]);
