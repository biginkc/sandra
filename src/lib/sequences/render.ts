/**
 * Minimal Handlebars-compatible template engine for sequence SMS bodies.
 *
 * Supported syntax:
 *   - `{{variable}}`                      — substitution
 *   - `{{#if variable}}body{{/if}}`       — conditional (truthy = render body)
 *
 * Behaviors:
 *   - Missing / null / undefined / empty-string variables render as `""`
 *     (safe default; never leak `"undefined"` into a live SMS).
 *   - Unknown variables behave the same as missing.
 *   - Malformed templates (e.g. unclosed `{{#if}}`) return the input
 *     unchanged so we don't silently eat content. Callers can lint at
 *     save time if they want stricter behavior.
 *   - Variable names must match `[a-zA-Z_]\w*` (underscore + alphanum).
 *     Rejects anything with spaces / dots to keep the surface small.
 *
 * Not supported in V1: `{{else}}`, iteration, nested `{{#if}}` blocks
 * with a shared variable, inline expressions. Can add later if needed.
 */

export type TemplateVars = Record<string, string | number | null | undefined>;

const CONDITIONAL_REGEX =
  /\{\{#if\s+([a-zA-Z_]\w*)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;

const VARIABLE_REGEX = /\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g;

function isTruthy(val: string | number | null | undefined): boolean {
  if (val === null || val === undefined) return false;
  if (typeof val === "string") return val.trim().length > 0;
  if (typeof val === "number") return val !== 0;
  return Boolean(val);
}

export function renderTemplate(
  template: string,
  vars: TemplateVars,
): string {
  // Pass 1: resolve conditionals (their body may contain variables).
  // Run repeatedly so adjacent / sequential conditionals all collapse;
  // bail after a safety-cap of 10 passes to avoid a pathological loop
  // on malformed input.
  let result = template;
  let previous = "";
  let iterations = 0;
  while (result !== previous && iterations++ < 10) {
    previous = result;
    result = result.replace(CONDITIONAL_REGEX, (_match, varName, body) => {
      const val = vars[varName];
      return isTruthy(val) ? body : "";
    });
  }

  // Pass 2: substitute bare variables.
  result = result.replace(VARIABLE_REGEX, (_match, varName) => {
    const val = vars[varName];
    if (val === null || val === undefined) return "";
    return String(val);
  });

  return result;
}
