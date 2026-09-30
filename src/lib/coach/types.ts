/** Script types are owned by @biginkc/coach; Sandra owns the live stream. */
export type {
  CoachCallContext, CoachEntryFields, CoachEntryToken, CoachOccupancy,
  CoachPhaseId, CoachToken, ResolvedToken, ResolvedTokens, ScriptBundle, ScriptRef,
} from "@biginkc/coach";
export { COACH_ENTRY_TOKENS, COACH_TOKENS } from "@biginkc/coach";

import type { CoachEntryFields, CoachPhaseId } from "@biginkc/coach";

export type CoachSpeaker = "rep" | "seller";
/**
 * Legacy producers carry only scriptVersion. The bound-script producer adds
 * scriptDigest; when it cannot bind a script it deliberately emits a
 * transcript-only `{ scriptVersion: null, scriptDigest: null }` identity.
 */
export type CoachEventVersions = { scriptVersion: string | null; scriptDigest?: string | null; matcherVersion: string };
export type CoachTranscriptEvent = CoachEventVersions & { type: "transcript"; speaker: CoachSpeaker; text: string; isFinal: boolean; ts: string };
export type CoachPhaseEvent = CoachEventVersions & { type: "phase"; phaseId: CoachPhaseId; ts: string };
export type CoachObjectionEvent = CoachEventVersions & { type: "objection"; objectionId: string; ts: string };
export type CoachObjectionPromptEvent = CoachEventVersions & { type: "objection_prompt"; objectionId: string; label: string; sellerTurn: number; classifierModel: string; questionsSha256: string; ts: string };
export type CoachMotivationPromptEvent = CoachEventVersions & { type: "motivation_prompt"; label: string; subType?: string; sellerTurn: number; classifierModel: string; questionsSha256: string; ts: string };
export type CoachCounterEvent = CoachEventVersions & { type: "counter"; probeCount: number; ts: string };
export type CoachGateEvent = CoachEventVersions & { type: "gate"; gateId: string; cleared: boolean; ts: string };
export type CoachTimerEvent = CoachEventVersions & { type: "timer"; timerId: string; startedAt: string; durationS: number; ts: string };
export type CoachNoteEvent = CoachEventVersions & { type: "coach_note"; text: string; phaseId: CoachPhaseId; ts: string };
export type CoachCursorEvent = CoachEventVersions & { type: "cursor"; phaseId: CoachPhaseId; branchTag: string; variantKey: string; lineIndex: number; lineText: string; ts: string };
export type CoachEvent = CoachTranscriptEvent | CoachPhaseEvent | CoachObjectionEvent | CoachObjectionPromptEvent | CoachMotivationPromptEvent | CoachCounterEvent | CoachGateEvent | CoachTimerEvent | CoachNoteEvent | CoachCursorEvent;

export type CoachTranscriptLine = { id: string; speaker: CoachSpeaker; text: string; isFinal: boolean; ts: string };
export type CoachObjectionCard = { id: string; objectionId: string; ts: string; expiresAt: number };
export type CoachObjectionPrompt = { objectionId: string; label: string; sellerTurn: number; classifierModel: string; questionsSha256: string; ts: string };
export type CoachMotivationPrompt = { label: string; subType?: string; sellerTurn: number; classifierModel: string; questionsSha256: string; ts: string };
export type CoachHoldTimer = { timerId: string; startedAt: string; durationS: number };
export type CoachCursor = { phaseId: CoachPhaseId; branchTag: string; variantKey: string; lineIndex: number; lineText: string; scriptVersion: string; ts: string };
export type CoachNudge = { id: string; text: string; phaseId: CoachPhaseId; ts: string; expiresAt: number };
export type CoachState = {
  connected: boolean; currentPhaseId: CoachPhaseId; overriddenPhaseId: CoachPhaseId | null;
  transcript: CoachTranscriptLine[]; transcriptFragments: CoachTranscriptLine[];
  objectionCards: CoachObjectionCard[]; objectionPrompt: CoachObjectionPrompt | null; motivationPrompt: CoachMotivationPrompt | null;
  /** The last accepted prompt of each kind, kept after a dismiss so a duplicate or older event cannot bring a dismissed card back. Cleared on reset. */
  lastObjectionPrompt: CoachObjectionPrompt | null; lastMotivationPrompt: CoachMotivationPrompt | null; nudges: CoachNudge[]; probeCount: number;
  gates: Record<string, boolean>; holdTimer: CoachHoldTimer | null; lastEventAt: string | null;
  entryFields: CoachEntryFields; cursor: CoachCursor | null;
};
