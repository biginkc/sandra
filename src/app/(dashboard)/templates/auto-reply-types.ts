/**
 * Outcomes an owner may map to an approved template for automatic replies.
 * Mirrors the `auto_reply_templates_outcome_check` constraint: opted_out, dnc
 * and wrong_number are never answered automatically. Labels are UI captions
 * only; no reply text lives here.
 */
export const AUTO_REPLY_OUTCOMES = [
  { outcome: "nurture", label: "Nurture" },
  { outcome: "not_interested", label: "Not interested" },
  { outcome: "new_lead", label: "New lead" },
] as const;

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
