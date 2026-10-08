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

export function formatRuleText(rule: LabelRule): string {
  return `${rule.outcome}: auto-apply at native confidence ≥ ${formatConfidence(rule.minConfidence)} (${rule.automationEnabled ? "ON" : "OFF"})`;
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
