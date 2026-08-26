/**
 * Coach event contract. The coach service (server side) broadcasts these
 * over a Supabase Realtime Broadcast channel named `coach:{call_id}`, where
 * call_id is the softphone's wrap token (the id minted once per call and
 * shared with Sandra wrap-up). This file is the single source of truth for
 * the shape both sides agree on — keep it in sync with the server.
 *
 * Channel authorization (who may subscribe to `coach:{call_id}`):
 * Jitter's softphone ledger (jitter_sandra_softphone_calls) lives in a
 * SEPARATE Supabase project from Sandra's, but broadcasts on this channel
 * land in Sandra's project — so ownership for Realtime Broadcast
 * Authorization is recorded Sandra-side, not traced through Jitter's
 * tables. `src/lib/dialer/jitter-server.ts`'s `startAuthenticatedJitterCall`
 * writes one row per call to `public.coach_call_index` (client_call_id,
 * operator_user_id, property_id) via the service-role client, BEFORE the
 * Jitter start-call request — so the row exists before the browser can
 * possibly subscribe. A `realtime.messages` RLS policy
 * (`supabase/migrations/20260826170000_coach_call_index.sql`) then allows
 * an authenticated user to receive broadcasts on `coach:{client_call_id}`
 * only when a coach_call_index row for that id has `operator_user_id =
 * auth.uid()`. The client must open the channel with
 * `{ config: { private: true } }` (see use-coach-channel.ts) for this
 * policy to be enforced at all — public channels bypass it entirely.
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
  "cold_caller_name",
  "closing_date",
  "offer_price",
  "net_to_seller",
] as const;

export type CoachToken = (typeof COACH_TOKENS)[number];

/** The three deal-panel tokens the rep types in live during the call —
 * never known at dial time, so they can't come from CoachCallContext. */
export const COACH_ENTRY_TOKENS = ["closing_date", "offer_price", "net_to_seller"] as const;

export type CoachEntryToken = (typeof COACH_ENTRY_TOKENS)[number];

export type CoachOccupancy = "owner_occupied" | "tenant_occupied" | "vacant" | "unknown";

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
  /** Assistant/cold-caller on the lead, if recorded — Sandra has no such
   * field today, so this is always null until one exists. */
  coldCallerName: string | null;
  /** Drives the Introduction phase's Opener branch auto-selection. */
  leadSource: string | null;
  /** Drives the Reveal phase's Entry branch auto-selection. */
  occupancy: CoachOccupancy | null;
};

export type ResolvedToken = { value: string; isPlaceholder: boolean };

export type ResolvedTokens = Record<CoachToken, ResolvedToken>;

/** Rep-entered deal-panel values, keyed by entry token. Null/unset renders
 * as an editable placeholder chip in the script panel. */
export type CoachEntryFields = Record<CoachEntryToken, string | null>;

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
  /** Rep-entered deal-panel values (closing_date/offer_price/net_to_seller). */
  entryFields: CoachEntryFields;
};
