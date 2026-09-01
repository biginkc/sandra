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

  let best: { objection: ScriptObjection; trigger: string; specificity: number; recency: number; catalogIndex: number } | null = null;
  for (const [catalogIndex, objection] of CLOSR_SCRIPT.objections.entries()) {
    for (const { line, index } of sellerTurns) {
      for (const trigger of objection.match.triggers) {
        if (!containsWholeTrigger(line.text, trigger)) continue;
        const specificity = normalize(trigger).split(" ").length;
        const candidate = { objection, trigger, specificity, recency: index, catalogIndex };
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
