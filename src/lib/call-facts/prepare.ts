import type { FactsInput } from "./types";

export const SUMMARY_MAX_CHARS = 4_000;
export const TRANSCRIPT_MAX_CHARS = 30_000;

/** The exact (bounded) text Jev sees and that evidence is validated against. */
export function prepareFactsInput(input: FactsInput): FactsInput {
  return {
    summary: input.summary ? input.summary.slice(0, SUMMARY_MAX_CHARS) : null,
    transcript: input.transcript ? input.transcript.slice(0, TRANSCRIPT_MAX_CHARS) : null,
  };
}
