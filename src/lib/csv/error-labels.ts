/**
 * Human-readable labels for validation rule keys.
 *
 * Rule keys live close to the validator (`src/lib/csv/validate.ts`) and are
 * useful for programmatic dispatch, but they leak straight into the wizard's
 * Review step where they read like internal jargon — `required: 873`, etc.
 * This module exists so the UI has a single canonical place to translate
 * them into the plain-English messages a user can act on.
 */

const RULE_LABELS: Record<string, string> = {
  required: "Missing required field",
  invalid_phone: "Invalid phone number",
  invalid_email: "Invalid email",
  invalid_zip: "Invalid ZIP",
  invalid_state: "Invalid state code",
  invalid_apn: "Invalid APN",
  invalid_county: "Invalid county",
  invalid_number: "Invalid number",
  invalid_int: "Invalid integer",
  invalid_boolean: "Invalid yes/no value",
  invalid_enum: "Value not in allowed list",
  section_required: "Required column not mapped",
  address_full_empty: "Address Full column is empty",
  address_full_no_street: "Address has city/state but no street",
  address_full_malformed: "Address Full couldn't be parsed",
  entity_without_name: "Entity contact missing entity name",
};

/**
 * Translate a rule key to a human-readable label. Falls back to the raw key
 * when no translation is registered, so new rules surface verbatim instead
 * of silently disappearing.
 */
export function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? rule;
}

/**
 * Pick the most-frequent error rule and return a short headline like
 * "Most are missing a required field." Returns null when there are no
 * errors.
 */
export function summarizeTopError(
  errorsByRule: Readonly<Record<string, number>>,
): string | null {
  const entries = Object.entries(errorsByRule);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [topRule, topCount] = entries[0];
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const label = ruleLabel(topRule).toLowerCase();
  if (entries.length === 1) return `All errors are: ${label}.`;
  if (topCount / total >= 0.8) return `Most are: ${label}.`;
  return `Top error: ${label} (${topCount} of ${total}).`;
}
