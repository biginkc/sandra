/**
 * Registry of available template variables for the SMS template system.
 *
 * Used by the variable picker UI and for validation when saving templates.
 * Each variable maps to a human-readable label and its data source.
 */

export type TemplateVariable = {
  /** The variable name used in `{{name}}` syntax. */
  name: string;
  /** Human-readable label shown in the picker dropdown. */
  label: string;
  /** Grouping for the picker dropdown (Contact, Property, Account). */
  group: "Contact" | "Property" | "Account";
  /** Example value shown in the live preview panel. */
  example: string;
};

export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  // Contact fields
  { name: "first_name", label: "First Name", group: "Contact", example: "John" },
  { name: "last_name", label: "Last Name", group: "Contact", example: "Smith" },

  // Property fields
  { name: "property_address", label: "Property Address", group: "Property", example: "123 Main St" },
  { name: "city", label: "City", group: "Property", example: "Dallas" },
  { name: "state", label: "State", group: "Property", example: "TX" },
  { name: "property_zip", label: "ZIP Code", group: "Property", example: "75201" },
  { name: "market", label: "Market", group: "Property", example: "DFW" },

  // Account fields
  { name: "my_first_name", label: "Sender Name", group: "Account", example: "Mel" },
  { name: "company_name", label: "Company Name", group: "Account", example: "Big Ink Consulting" },
] as const;

/**
 * Build a sample vars object for the live preview panel.
 * Uses the `example` value from each registered variable.
 */
export function buildSampleVars(
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const v of TEMPLATE_VARIABLES) {
    vars[v.name] = overrides[v.name] ?? v.example;
  }
  return vars;
}

/** Set of all known variable names for quick lookup. */
export const KNOWN_VARIABLE_NAMES = new Set(
  TEMPLATE_VARIABLES.map((v) => v.name),
);
