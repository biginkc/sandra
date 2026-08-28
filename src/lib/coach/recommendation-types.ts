import type { CoachSpeaker } from "./types";

export type CoachRecommendationMode = "automatic" | "follow_up";

export type CoachRecommendationTranscriptLine = {
  id?: string;
  speaker: CoachSpeaker;
  text: string;
  isFinal: boolean;
  ts?: string;
};

export type CoachRecommendationRequest = {
  requestId: string;
  callId: string;
  activeSectionId: string;
  branchOverrides: Record<string, string>;
  mode: CoachRecommendationMode;
  transcript: CoachRecommendationTranscriptLine[];
};

export type CoachRecommendationSuccess = {
  ok: true;
  requestId: string;
  callId: string;
  activeSectionId: string;
  mode: CoachRecommendationMode;
  recommendations: string[];
  followUpQuestions: string[];
};

export type CoachRecommendationFailureCode =
  | "invalid_request"
  | "unauthorized"
  | "call_not_owned"
  | "rate_limited"
  | "provider_error";

export type CoachRecommendationFailure = {
  ok: false;
  requestId: string;
  callId: string;
  activeSectionId: string;
  mode: CoachRecommendationMode;
  code: CoachRecommendationFailureCode;
};

export type CoachRecommendationResult =
  | CoachRecommendationSuccess
  | CoachRecommendationFailure;

export type CoachRecommendationRequestFn = (
  input: CoachRecommendationRequest,
) => Promise<CoachRecommendationResult>;
