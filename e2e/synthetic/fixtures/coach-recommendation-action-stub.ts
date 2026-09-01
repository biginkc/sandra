import type {
  CoachRecommendationRequest,
  CoachRecommendationResult,
} from "@/lib/coach/recommendation-types";

export async function requestCoachRecommendations(
  input: CoachRecommendationRequest,
): Promise<CoachRecommendationResult> {
  if (input.mode === "objection_help") {
    return {
      ok: true,
      requestId: input.requestId,
      callId: input.callId,
      activeSectionId: input.activeSectionId,
      mode: "objection_help",
      objectionId: null,
      evidenceQuote: null,
    };
  }
  return {
    ok: true,
    requestId: input.requestId,
    callId: input.callId,
    activeSectionId: input.activeSectionId,
    mode: "follow_up",
    followUpQuestions: [],
  };
}
