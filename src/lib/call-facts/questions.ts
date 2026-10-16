import { FACT_SLOTS, type FactSlotDef } from "./catalog";

/**
 * The Jev question registry, one slot per approved question (see catalog.ts). All wording is
 * Jarrad-approved verbatim (./approved, ./question-text.ts). A slot whose `text` is null is
 * skipped; with no active slot the sweep writes only the Dialpad summary note and never calls Jev.
 */
export type FactQuestionSlot = FactSlotDef;
export const FACT_QUESTIONS: readonly FactQuestionSlot[] = FACT_SLOTS;

export const activeQuestions = (slots: readonly FactQuestionSlot[] = FACT_QUESTIONS) =>
  slots.filter((s) => typeof s.text === "string" && s.text.trim() !== "");
