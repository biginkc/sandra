import type { CoachRecommendationTranscriptLine } from "./recommendation-types";

export const MAX_RECOMMENDATION_TRANSCRIPT_LINES = 40;
export const MAX_RECOMMENDATION_TRANSCRIPT_CHARS = 12_000;
export const AUTOMATIC_RECOMMENDATION_LIMIT_PER_CALL = 40;
export const FOLLOW_UP_RECOMMENDATION_LIMIT_PER_CALL = 20;

export function isMeaningfulFinalSellerTurn(
  line: CoachRecommendationTranscriptLine | undefined,
): boolean {
  if (!line || !line.isFinal || line.speaker !== "seller") return false;
  const normalized = line.text.trim().toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ");
  if (!normalized) return false;
  if (/^(?:yes|yeah|yep|no|nope|okay|ok|sure|right|correct|uh huh|mm hmm|thanks|thank you)$/.test(normalized)) {
    return false;
  }
  return normalized.length >= 12 && normalized.split(" ").filter(Boolean).length >= 3;
}
