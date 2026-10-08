/**
 * Luna suggestion feature switches. Reads env only; never returns the key.
 *
 * Luna (OpenAI) is a FALLBACK SUGGESTION on hold cards, never auto-applied.
 * Off by default: with LUNA_SUGGESTIONS_ENABLED unset (or anything but "1") or
 * OPENAI_API_KEY missing there are no Luna calls and no Luna UI.
 */

export const LUNA_DEFAULT_MODEL = "gpt-6-luna";
/** One attempt, hard timeout. There is deliberately no retry. */
export const LUNA_TIMEOUT_MS = 15_000;

type Env = Record<string, string | undefined>;

export function lunaSuggestionsEnabled(env: Env = process.env): boolean {
  return env.LUNA_SUGGESTIONS_ENABLED === "1" && (env.OPENAI_API_KEY ?? "").trim() !== "";
}

export function lunaModelFromEnv(env: Env = process.env): string {
  return (env.LUNA_MODEL ?? "").trim() || LUNA_DEFAULT_MODEL;
}
