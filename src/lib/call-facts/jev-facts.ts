import { askJev, type JevAskRequest, type JevChoiceQuestion, type JevNoulQuestion } from "@/lib/sms-classification/providers/jev-gateway";
import { JEV_MODEL } from "@/lib/sms-classification/questions";

import { findAmountCandidates, findDateCandidates, MAX_OPTIONS, parseTurns, turnState, type Turn } from "./candidates";
import { CLOSER_LAB_FRAMING } from "./catalog";
import { activeQuestions, FACT_QUESTIONS, type FactQuestionSlot } from "./questions";
import type { FactsInput, RawFacts } from "./types";

/**
 * Fact extraction on Jev (TypeSafe System One), reusing Sandra's one Jev client (askJev) and its
 * TYPESAFE_API_KEY handling. Jev only CHOOSES or SCORES; code owns every string:
 *   - "turn" questions: options are the turn labels (T001...) plus "none"; the evidence (and the
 *     value) is that turn's text, copied by code.
 *   - "amount" / "date" questions: code finds every candidate (over-finds), Jev picks which one
 *     answers the question or "none", code copies the value. Dates are resolved in code.
 *   - "line_noul" questions (Closer Lab's approved set): per seller turn, Jev is shown the
 *     transcript up to and including that turn with Closer Lab's approved framing, and answers each
 *     yes/no as a probability; a turn at or above the question's threshold is a hit and the best
 *     hit is the evidence.
 * Options carry null descriptions: no wording is added by this module. A slot whose text is null is
 * skipped; with no active slot Jev is never called.
 */
export const NONE = "none";
export const SELLER_SPEAKER = "Other party";
/** Cost/time bounds: at most this many seller turns are scored per call, this many requests in flight. */
export const MAX_SCORED_TURNS = 40;
export const SCORING_CONCURRENCY = 4;

export type JevAnswer = { choice?: unknown; noul?: unknown };
export type JevAsk = (request: JevAskRequest) => Promise<Record<string, JevAnswer | undefined>>;
export type FactsExtraction = { facts: RawFacts; model: string | null };
export type FactsExtractor = (input: FactsInput, ctx: { now: Date }) => Promise<FactsExtraction>;

const options = (labels: string[]): Record<string, null> => ({ ...Object.fromEntries(labels.map((l) => [l, null])), [NONE]: null });
const probability = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);

/** Closer Lab renderLineQuestionText: prefix({turn}) + question + suffix. */
export const lineQuestionText = (turn: number, question: string): string =>
  `${CLOSER_LAB_FRAMING.prefix.replace("{turn}", String(turn))}${question}${CLOSER_LAB_FRAMING.suffix}`;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export function createJevFactsExtractor(ask: JevAsk, opts: { questions?: readonly FactQuestionSlot[] } = {}): FactsExtractor {
  const slots = activeQuestions(opts.questions ?? FACT_QUESTIONS);
  return async (input, { now }) => {
    const turns = parseTurns(input);
    if (slots.length === 0 || turns.length === 0) return { facts: {}, model: null };
    const facts: RawFacts = {};
    let asked = false;

    // 1. One request for every choice-style question (turn / amount / date).
    const choiceSlots = slots.filter((s) => s.kind !== "line_noul");
    const questions: Record<string, JevChoiceQuestion> = {};
    const resolve: Record<string, Map<string, { turn: Turn; value: string }>> = {};
    for (const slot of choiceSlots) {
      const map = new Map<string, { turn: Turn; value: string }>();
      if (slot.kind === "turn") {
        for (const t of turns.slice(0, MAX_OPTIONS)) map.set(t.label, { turn: t, value: t.text.slice(0, 300) });
      } else if (slot.kind === "amount") {
        for (const c of findAmountCandidates(turns)) map.set(`${c.turn.label}|${c.raw}`, { turn: c.turn, value: c.raw });
      } else {
        for (const c of findDateCandidates(turns, now)) map.set(`${c.turn.label}|${c.raw}`, { turn: c.turn, value: c.date });
      }
      if (map.size === 0) continue; // nothing to choose from: no question
      resolve[slot.field] = map;
      questions[slot.field] = { type: "choice", instructions: slot.text as string, criteria: options([...map.keys()]) };
    }
    if (Object.keys(questions).length > 0) {
      asked = true;
      const answers = await ask({ state: turnState(turns), questions });
      for (const slot of choiceSlots) {
        const choice = answers[slot.field]?.choice;
        if (typeof choice !== "string" || choice === NONE) continue;
        const picked = resolve[slot.field]?.get(choice);
        if (!picked) continue; // not an offered option: ignored
        facts[slot.field] = { value: picked.value, evidence: picked.turn.text };
      }
    }

    // 2. Closer Lab's approved yes/no set, scored per seller turn.
    const lineSlots = slots.filter((s) => s.kind === "line_noul");
    if (lineSlots.length > 0) {
      const sellerIdx = turns.map((t, i) => [t, i] as const).filter(([t]) => t.speaker === SELLER_SPEAKER);
      // No identified seller speaker: score every turn rather than none.
      const targets = (sellerIdx.length > 0 ? sellerIdx : turns.map((t, i) => [t, i] as const)).slice(0, MAX_SCORED_TURNS);
      if (targets.length > 0) {
        asked = true;
        const best: Record<string, { p: number; turn: Turn }> = {};
        const results = await mapLimit(targets, SCORING_CONCURRENCY, async ([turn, index]) => {
          const noul: Record<string, JevNoulQuestion> = {};
          for (const slot of lineSlots) noul[slot.field] = { type: "noul", instructions: lineQuestionText(index + 1, slot.text as string) };
          const state = { transcript: turns.slice(0, index + 1).map((t, i) => ({ turn: i + 1, speaker: t.speaker ?? "unknown", text: t.text })) };
          return { turn, answers: await ask({ state, questions: noul }) };
        });
        for (const { turn, answers } of results) {
          for (const slot of lineSlots) {
            const p = probability(answers[slot.field]?.noul);
            if (p === null || p < (slot.threshold ?? 1)) continue;
            if (!best[slot.field] || p > best[slot.field].p) best[slot.field] = { p, turn }; // earliest wins a tie
          }
        }
        for (const slot of lineSlots) {
          const hit = best[slot.field];
          if (hit) facts[slot.field] = { value: hit.turn.text.slice(0, 300), evidence: hit.turn.text };
        }
      }
    }
    return { facts, model: asked ? JEV_MODEL : null };
  };
}

/** Null (summary note only) when there is no TYPESAFE_API_KEY or no question has approved text. */
export function createFactsExtractorFromEnv(
  env: Record<string, string | undefined> = process.env,
  questions: readonly FactQuestionSlot[] = FACT_QUESTIONS,
  fetchImpl: typeof fetch = fetch,
): FactsExtractor | null {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey || activeQuestions(questions).length === 0) return null;
  const ask: JevAsk = async (request) => {
    const result = await askJev(request, { fetch: fetchImpl, apiKey, timeoutMs: 15_000 });
    return (result.answers ?? {}) as Record<string, JevAnswer>;
  };
  return createJevFactsExtractor(ask, { questions });
}
