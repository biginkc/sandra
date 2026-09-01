import type {
  CoachRecommendationRequest,
  CoachRecommendationResult,
} from "@/lib/coach/recommendation-types";

export async function requestCoachRecommendations(
  input: CoachRecommendationRequest,
): Promise<CoachRecommendationResult> {
  return {
    ok: true,
    requestId: input.requestId,
    callId: input.callId,
    activeSectionId: input.activeSectionId,
    mode: input.mode,
    followUpQuestions: [],
  };
}
