import type { CoachSpeaker } from "./types";

export type CoachRecommendationMode = "follow_up" | "objection_help";

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
  selectedSectionBranch: string | null;
  branchOverrides: Record<string, string>;
  mode: CoachRecommendationMode;
  transcript: CoachRecommendationTranscriptLine[];
};

export type CoachRecommendationFollowUpSuccess = {
  ok: true;
  requestId: string;
  callId: string;
  activeSectionId: string;
  mode: "follow_up";
  followUpQuestions: string[];
};

// The model never writes guidance — it only names which catalog objection
// (if any) the seller is voicing, plus the seller's own words as evidence.
// The approved acknowledge/disarm/overcome text is always resolved client
// side from the catalog by objectionId, never sent over the wire.
export type CoachRecommendationObjectionHelpSuccess = {
  ok: true;
  requestId: string;
  callId: string;
  activeSectionId: string;
  mode: "objection_help";
  objectionId: string | null;
  evidenceQuote: string | null;
};

export type CoachRecommendationSuccess =
  | CoachRecommendationFollowUpSuccess
  | CoachRecommendationObjectionHelpSuccess;

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
