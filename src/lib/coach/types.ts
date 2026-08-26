/**
 * Coach event contract. The coach service (server side) broadcasts these
 * over a Supabase Realtime Broadcast channel named `coach:{call_id}`, where
 * call_id is the softphone's wrap token (the id minted once per call and
 * shared with Sandra wrap-up). This file is the single source of truth for
 * the shape both sides agree on — keep it in sync with the server.
 */

export type CoachSpeaker = "rep" | "seller";

export type CoachPhaseId =
  | "introduction"
  | "reveal"
  | "assessment"
  | "secure_positioning"
  | "offer"
  | "close";

export const COACH_PHASE_ORDER: readonly CoachPhaseId[] = [
  "introduction",
  "reveal",
  "assessment",
  "secure_positioning",
  "offer",
  "close",
];

export type CoachTranscriptEvent = {
  type: "transcript";
  speaker: CoachSpeaker;
  text: string;
  isFinal: boolean;
  ts: string;
};

export type CoachPhaseEvent = {
  type: "phase";
  phaseId: CoachPhaseId;
  ts: string;
};

export type CoachObjectionEvent = {
  type: "objection";
  objectionId: string;
  ts: string;
};

export type CoachCounterEvent = {
  type: "counter";
  /** Reveal-phase probe counter — number of discovery questions asked so far. */
  probeCount: number;
  ts: string;
};

export type CoachGateEvent = {
  type: "gate";
  gateId: string;
  cleared: boolean;
  ts: string;
};

export type CoachTimerEvent = {
  type: "timer";
  timerId: string;
  startedAt: string;
  durationS: number;
  ts: string;
};

export type CoachEvent =
  | CoachTranscriptEvent
  | CoachPhaseEvent
  | CoachObjectionEvent
  | CoachCounterEvent
  | CoachGateEvent
  | CoachTimerEvent;

// ---- Token resolution ----

export const COACH_TOKENS = [
  "seller_name",
  "rep_name",
  "property_address",
  "motivation",
  "rep_phone",
  "file_number",
] as const;

export type CoachToken = (typeof COACH_TOKENS)[number];

/** Raw, unresolved facts gathered at dial time. Any field may be missing —
 * the resolver renders a placeholder chip instead of leaving text blank. */
export type CoachCallContext = {
  sellerName: string | null;
  propertyAddress: string | null;
  propertyCounty: string | null;
  repName: string | null;
  repPhoneE164: string | null;
  motivation: string | null;
  leadId: string | null;
  sellerPhoneE164: string | null;
};

export type ResolvedToken = { value: string; isPlaceholder: boolean };

export type ResolvedTokens = Record<CoachToken, ResolvedToken>;

// ---- Reducer state ----

export type CoachTranscriptLine = {
  /** Stable id: finals get a fresh id per utterance, the live interim line
   * reuses one id per speaker so it updates in place instead of stacking. */
  id: string;
  speaker: CoachSpeaker;
  text: string;
  isFinal: boolean;
  ts: string;
};

export type CoachObjectionCard = {
  /** Instance id — unique per occurrence, even for a repeated objectionId. */
  id: string;
  objectionId: string;
  ts: string;
};

export type CoachHoldTimer = {
  timerId: string;
  startedAt: string;
  durationS: number;
};

export type CoachState = {
  /** True once the first event of any kind has arrived. */
  connected: boolean;
  currentPhaseId: CoachPhaseId;
  /** Set when the rep manually taps a phase on the rail; cleared on the
   * next server phase event. Display-only — never sent back to the server. */
  overriddenPhaseId: CoachPhaseId | null;
  transcript: CoachTranscriptLine[];
  objectionCards: CoachObjectionCard[];
  probeCount: number;
  gates: Record<string, boolean>;
  holdTimer: CoachHoldTimer | null;
  lastEventAt: string | null;
};
