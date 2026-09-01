import { CLOSR_SCRIPT, resolveObjectionOvercome } from "./script-block";
import type { ScriptObjection } from "./script-schema";
import type { CoachRecommendationTranscriptLine } from "./recommendation-types";
import type { CoachOccupancy, ResolvedTokens } from "./types";
import { resolveDisplayText } from "./token-resolver";

export type CoachObjectionHelp =
  | {
      kind: "match";
      objectionId: string;
      label: string;
      matchedTrigger: string;
      tonality: string | null;
      acknowledge: string;
      disarm: string;
      overcome: string;
      templateNote: string | null;
    }
  | {
      kind: "no_match";
      message: string;
    };

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/'/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function containsWholeTrigger(text: string, trigger: string): boolean {
  const normalizedText = normalize(text);
  const normalizedTrigger = normalize(trigger);
  if (!normalizedText || !normalizedTrigger) return false;
  return ` ${normalizedText} `.includes(` ${normalizedTrigger} `);
}

// A trigger phrase of three or more words is, on its own, distinctive
// enough that a seller would only realistically say it while voicing this
// exact objection ("talk to my spouse", "put it on the market"). Below
// that length, several catalog triggers are single ordinary nouns or short
// generic fragments that also occur in completely unrelated remarks —
// "inspections", "how much", "my number", "zillow", "scam" — and treating
// any one of those as proof by itself misreads routine conversation as an
// objection. Confirmed misfires (PR #457 review, and this file's own
// negative-corpus tests): "My number is 816-555-1234" -> right_price_only;
// "How much time do you need for the walkthrough?" -> straight_to_offer;
// "We had inspections done last year" -> no_showings; "Who are you again,
// sorry I didn't catch your name?" -> end_buyer despite being 3 words.
// Those triggers require either a positive-context guard confirming the
// sentence actually carries objection intent, or a second, independent
// trigger for the SAME objection elsewhere in the finalized seller speech,
// before the match counts as evidence.
const STRONG_TRIGGER_MIN_WORDS = 3;

// Multi-word triggers that clear the length bar above but were proven by
// the negative-corpus tests to still misfire on ordinary speech, and so are
// treated as weak despite their length.
const DOWNGRADED_MULTIWORD_TRIGGERS = new Set(["who are you"]);

const PRICE_CONTEXT = /\$|dollar|price|worth\b|offer|pay(?:ing)?\b|cash|money/i;
const RESISTANCE_CONTEXT = /don'?t want|do not want|not comfortable|uncomfortable|nervous|worried|won'?t allow|can'?t have|refuse|no more|tired of|not okay with|allowed to see/i;

// Guards for specific weak (ambiguous) triggers where a reliable positive
// signal exists: a nearby word that only shows up when the seller means
// this as pushback, not as a factual or logistics remark. Evaluated
// against the full matched line. Weak triggers with no entry here fall
// back to requiring corroboration from a second, distinct trigger for the
// same objection (see `isEligibleHit` below) — that is the safe default,
// not a gap, since a guard that is only a guess is worse than none.
const WEAK_TRIGGER_GUARDS: Record<string, (line: string) => boolean> = {
  "my number": (line) => PRICE_CONTEXT.test(line),
  "how much": (line) => PRICE_CONTEXT.test(line),
  strangers: (line) => RESISTANCE_CONTEXT.test(line),
  showings: (line) => RESISTANCE_CONTEXT.test(line),
  walkthrough: (line) => RESISTANCE_CONTEXT.test(line),
  inspections: (line) => RESISTANCE_CONTEXT.test(line),
};

function isStrongTrigger(normalizedTrigger: string): boolean {
  if (DOWNGRADED_MULTIWORD_TRIGGERS.has(normalizedTrigger)) return false;
  return normalizedTrigger.split(" ").length >= STRONG_TRIGGER_MIN_WORDS;
}

type RawHit = { objection: ScriptObjection; trigger: string; line: CoachRecommendationTranscriptLine; index: number };

// A weak trigger counts as evidence only when it clears its own guard, or
// when some OTHER, differently-worded trigger for the same objection also
// fired somewhere in the finalized seller speech — two independent
// ambiguous signals pointing the same direction are trustworthy in a way
// that one alone is not.
function isEligibleHit(hit: RawHit, sameObjectionHits: readonly RawHit[]): boolean {
  const normalizedTrigger = normalize(hit.trigger);
  if (isStrongTrigger(normalizedTrigger)) return true;

  const guard = WEAK_TRIGGER_GUARDS[normalizedTrigger];
  if (guard) return guard(hit.line.text);

  return sameObjectionHits.some((other) => normalize(other.trigger) !== normalizedTrigger);
}

function humanizeObjectionId(id: string): string {
  return id
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveText(text: string, tokens: ResolvedTokens): string {
  return resolveDisplayText(text, tokens)
    .map((segment) => {
      if (segment.kind === "tone") return "";
      return segment.kind === "text" ? segment.value : segment.resolved.value;
    })
    .join("");
}

function matchedObjection(
  transcript: readonly CoachRecommendationTranscriptLine[],
): { objection: ScriptObjection; trigger: string } | null {
  // Only finalized seller speech is evidence. Rep speech, interim text, and
  // catalog/event IDs must never surface a playbook card by themselves.
  const sellerTurns = transcript
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.speaker === "seller" && line.isFinal);

  const rawHits: RawHit[] = [];
  for (const objection of CLOSR_SCRIPT.objections) {
    for (const { line, index } of sellerTurns) {
      for (const trigger of objection.match.triggers) {
        if (containsWholeTrigger(line.text, trigger)) {
          rawHits.push({ objection, trigger, line, index });
        }
      }
    }
  }

  let best: { objection: ScriptObjection; trigger: string; specificity: number; recency: number; catalogIndex: number } | null = null;
  for (const [catalogIndex, objection] of CLOSR_SCRIPT.objections.entries()) {
    const sameObjectionHits = rawHits.filter((hit) => hit.objection.id === objection.id);
    for (const hit of sameObjectionHits) {
      if (!isEligibleHit(hit, sameObjectionHits)) continue;
      const specificity = normalize(hit.trigger).split(" ").length;
      const candidate = { objection, trigger: hit.trigger, specificity, recency: hit.index, catalogIndex };
      if (
        !best
        || candidate.specificity > best.specificity
        || (candidate.specificity === best.specificity && candidate.recency > best.recency)
        || (candidate.specificity === best.specificity && candidate.recency === best.recency && candidate.catalogIndex < best.catalogIndex)
      ) {
        best = candidate;
      }
    }
  }

  return best ? { objection: best.objection, trigger: best.trigger } : null;
}

export function findObjectionHelp(
  transcript: readonly CoachRecommendationTranscriptLine[],
  tokens: ResolvedTokens,
  occupancy: CoachOccupancy | null,
): CoachObjectionHelp {
  const match = matchedObjection(transcript);
  if (!match) {
    return {
      kind: "no_match",
      message: "No clear objection was found in the finalized homeowner speech.",
    };
  }

  const { objection, trigger } = match;
  return {
    kind: "match",
    objectionId: objection.id,
    label: humanizeObjectionId(objection.id),
    matchedTrigger: trigger,
    tonality: objection.display.tonality,
    acknowledge: resolveText(objection.display.acknowledge, tokens),
    disarm: resolveText(objection.display.disarm, tokens),
    overcome: resolveText(resolveObjectionOvercome(objection, occupancy), tokens),
    templateNote: objection.display.template_note ? resolveText(objection.display.template_note, tokens) : null,
  };
}
