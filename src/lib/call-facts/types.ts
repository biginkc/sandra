/**
 * Call facts (TECH-PLAN-2026-10 section 3.12). Pure types: safe for client bundles.
 * Display priority is the order of FACT_FIELDS (catalog.ts); `condition` is deliberately last.
 */
export { FACT_FIELDS, FACT_LABELS, type FactField } from "./catalog";
import { FACT_FIELDS, type FactField } from "./catalog";

/** What the model returns per field, before validation. */
export type RawFact = { value: string | null; evidence: string | null };
export type RawFacts = Partial<Record<FactField, RawFact>>;

/** A fact that survived validation. */
export type ValidFact = { value: string; evidence: string };
export type ValidFacts = Partial<Record<FactField, ValidFact>>;

/** The text the model is shown, and the text evidence is checked against. */
export type FactsInput = { summary: string | null; transcript: string | null };

export function isFactField(value: unknown): value is FactField {
  return typeof value === "string" && (FACT_FIELDS as readonly string[]).includes(value);
}
