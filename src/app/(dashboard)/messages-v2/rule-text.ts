/**
 * Exact wording of a per-label automation rule, shown in the confirmation a
 * human reads before changing it. Nothing here chooses a value: the numbers
 * come from the stored rule or from what the owner typed, and the same
 * function renders both the "before" and the "after" text.
 */

export type LabelRule = {
  outcome: string;
  minConfidence: number;
  automationEnabled: boolean;
};

/** 0.9 -> "0.90", 0.925 -> "0.925", 1 -> "1.00": at least two decimals, never rounded. */
export function formatConfidence(value: number): string {
  const three = value.toFixed(3);
  return three.endsWith("0") ? three.slice(0, -1) : three;
}

/**
 * PR 4: the app's old eight-answer label names never reach the screen. Each rule is named
 * with the plain words already used on the rules panel and the tape.
 */
const RULE_TITLES: Record<string, string> = {
  new_lead: "Open to selling or wants an offer",
  nurture: "Maybe later",
  not_interested: "Not interested",
  wrong_number: "Wrong person",
  opted_out: "Asked to stop",
  dnc: "Asked to stop",
};

/** Plain name for an eight-answer label, or null when the word is not one of them. */
export function plainOutcome(word: string): string | null {
  return RULE_TITLES[word] ?? null;
}

/** Plain name for a rule; "this rule" for anything not named above. */
export function ruleTitle(outcome: string): string {
  return RULE_TITLES[outcome] ?? "this rule";
}

export function formatRuleText(rule: LabelRule): string {
  return `${ruleTitle(rule.outcome)}: auto-apply at native confidence ≥ ${formatConfidence(rule.minConfidence)} (${rule.automationEnabled ? "ON" : "OFF"})`;
}

export type ParsedConfidence =
  | { ok: true; value: number }
  | { ok: false; reason: string };

/**
 * A typed cutoff: a plain decimal from 0 to 1 with at most three decimals (the
 * database stores three, so anything finer would be silently rounded and the
 * confirmation text would not be what gets saved).
 */
export function parseConfidenceInput(raw: string): ParsedConfidence {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "Enter a number from 0 to 1." };
  if (!/^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?|\.\d{1,3})$/.test(text)) {
    return { ok: false, reason: "Use a number from 0 to 1 with at most three decimals." };
  }
  return { ok: true, value: Number(text) };
}
