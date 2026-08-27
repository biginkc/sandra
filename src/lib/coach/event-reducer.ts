import { CLOSR_SCRIPT } from "./script-block";
import { EMPTY_ENTRY_FIELDS } from "./token-resolver";
import type { CoachEntryToken, CoachEvent, CoachPhaseId, CoachState, CoachTranscriptEvent, CoachTranscriptLine } from "./types";

/** Local, client-only actions layered on top of server CoachEvents — never
 * broadcast back to the server. Card/nudge dismissal is owned per-instance
 * by the component itself (its own 45s timer or a tap), not driven from
 * here. */
export type CoachLocalAction =
  | { type: "dismiss_objection"; cardId: string }
  | { type: "dismiss_nudge"; nudgeId: string }
  | { type: "override_phase"; phaseId: CoachPhaseId }
  | { type: "set_entry_field"; field: CoachEntryToken; value: string }
  /** Dispatched by useCoachChannel whenever callId changes — a fresh call
   * must start from a clean slate. Not "clear the transcript" bolted onto
   * existing state; it's a full replacement with initialCoachState so no
   * field can be missed as the shape evolves. */
  | { type: "reset"; startingPhaseId: CoachPhaseId };

export type CoachReducerAction = CoachEvent | CoachLocalAction;

/** Caps in-memory transcript growth for very long calls. */
const MAX_TRANSCRIPT_LINES = 500;

/** Objection card and nudge dismiss TTLs — lives here, not in the UI
 * component, because CoachObjectionCard.expiresAt/CoachNudge.expiresAt are
 * computed once at insert time (Date.now() + TTL), not per-render. A card
 * is heavier (three-beat Acknowledge/Disarm/Overcome layout) and stays up
 * longer than a nudge (a one-line coaching prompt). */
export const OBJECTION_CARD_TTL_MS = 45_000;
export const NUDGE_TTL_MS = 20_000;

/** Bounds how many simultaneously-visible guidance cards/nudges the
 * GuidanceOverlay stack ever has to lay out. This is a hard cap on STATE,
 * not just rendering — a purely presentational cap (slicing the array only
 * at render time) would leave the un-rendered cards mounted nowhere, so
 * their own auto-dismiss timer effect would never run and they'd sit in
 * state forever. Dropping the oldest here means anything capped out is
 * actually gone, not a zombie waiting on a timer that never fires. Combined
 * with the stack's own max-height + internal scroll, this is what keeps
 * the guidance overlay from ever growing tall enough to cover the call
 * dock, even if objections/nudges fire in a rapid burst. */
export const MAX_OBJECTION_CARDS = 3;
export const MAX_NUDGES = 3;

export function initialCoachState(startingPhaseId: CoachPhaseId = "introduction"): CoachState {
  return {
    connected: false,
    currentPhaseId: startingPhaseId,
    overriddenPhaseId: null,
    transcript: [],
    objectionCards: [],
    nudges: [],
    probeCount: 0,
    gates: {},
    holdTimer: null,
    lastEventAt: null,
    entryFields: { ...EMPTY_ENTRY_FIELDS },
    cursor: null,
  };
}

let transcriptSeq = 0;
/** Monotonic, module-scoped — NOT derived from the post-cap array length.
 * Two objection/coach_note events sharing a timestamp (the producer's ts
 * granularity doesn't guarantee uniqueness) previously collided on
 * `${id}-${ts}-${state.cards.length}` once the cap started dropping the
 * oldest card each insert, since the length recycles back to the same
 * value — two cards could land on the exact same id, so dismissing one
 * removed both. A counter that only ever increments can't repeat. */
let objectionCardSeq = 0;
let nudgeSeq = 0;

/** A live interim result replaces THAT SPEAKER's still-open interim line in
 * place; a final either commits that line or, if the speaker's most recent
 * line was already final (or they have no line yet), appends fresh. Each
 * speaker owns at most one open (non-final) line at a time, so this looks
 * for the most recent line FROM THIS SPEAKER specifically — not merely the
 * last line in the whole transcript, which the other speaker may have
 * appended in between (e.g. rep-interim -> seller-interim -> rep-final
 * must update the rep's line, not append a duplicate because the seller's
 * interim is now the trailing line). */
function upsertTranscriptLine(
  transcript: CoachTranscriptLine[],
  event: CoachTranscriptEvent,
): CoachTranscriptLine[] {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i].speaker !== event.speaker) continue;
    if (transcript[i].isFinal) break; // most recent line from this speaker is already closed — start fresh
    const updated: CoachTranscriptLine = { ...transcript[i], text: event.text, isFinal: event.isFinal, ts: event.ts };
    return [...transcript.slice(0, i), updated, ...transcript.slice(i + 1)];
  }
  transcriptSeq += 1;
  const line: CoachTranscriptLine = {
    id: `${event.speaker}-${transcriptSeq}`,
    speaker: event.speaker,
    text: event.text,
    isFinal: event.isFinal,
    ts: event.ts,
  };
  const next = [...transcript, line];
  return next.length > MAX_TRANSCRIPT_LINES ? next.slice(next.length - MAX_TRANSCRIPT_LINES) : next;
}

export function coachReducer(state: CoachState, action: CoachReducerAction): CoachState {
  switch (action.type) {
    case "transcript":
      return {
        ...state,
        connected: true,
        lastEventAt: action.ts,
        transcript: upsertTranscriptLine(state.transcript, action),
      };
    case "phase": {
      // A cursor is only ever stored for the phase it was validated
      // against (see the "cursor" case below) — once the server actually
      // moves to a different phase, that stored cursor describes a phase
      // the call has left behind and must not keep being applied. Guarded
      // on an actual change (not just a redundant re-broadcast of the same
      // phaseId) so a duplicate phase event can't wipe a still-valid cursor.
      const phaseChanged = action.phaseId !== state.currentPhaseId;
      return {
        ...state,
        connected: true,
        lastEventAt: action.ts,
        currentPhaseId: action.phaseId,
        // Server truth always wins over a manual rail tap.
        overriddenPhaseId: null,
        cursor: phaseChanged ? null : state.cursor,
      };
    }
    case "objection": {
      objectionCardSeq += 1;
      const nextObjectionCards = [
        ...state.objectionCards,
        {
          id: `${action.objectionId}-${action.ts}-${objectionCardSeq}`,
          objectionId: action.objectionId,
          ts: action.ts,
          expiresAt: Date.now() + OBJECTION_CARD_TTL_MS,
        },
      ];
      return {
        ...state,
        connected: true,
        lastEventAt: action.ts,
        objectionCards: nextObjectionCards.length > MAX_OBJECTION_CARDS
          ? nextObjectionCards.slice(nextObjectionCards.length - MAX_OBJECTION_CARDS)
          : nextObjectionCards,
      };
    }
    case "counter":
      return {
        ...state,
        connected: true,
        lastEventAt: action.ts,
        probeCount: action.probeCount,
      };
    case "gate":
      return {
        ...state,
        connected: true,
        lastEventAt: action.ts,
        gates: { ...state.gates, [action.gateId]: action.cleared },
      };
    case "timer":
      return {
        ...state,
        connected: true,
        lastEventAt: action.ts,
        holdTimer: { timerId: action.timerId, startedAt: action.startedAt, durationS: action.durationS },
      };
    case "coach_note": {
      nudgeSeq += 1;
      const nextNudges = [
        ...state.nudges,
        {
          id: `${action.phaseId}-${action.ts}-${nudgeSeq}`,
          text: action.text,
          phaseId: action.phaseId,
          ts: action.ts,
          expiresAt: Date.now() + NUDGE_TTL_MS,
        },
      ];
      return {
        ...state,
        connected: true,
        lastEventAt: action.ts,
        nudges: nextNudges.length > MAX_NUDGES ? nextNudges.slice(nextNudges.length - MAX_NUDGES) : nextNudges,
      };
    }
    case "cursor": {
      // Phase is authoritative: a cursor for any phase other than the one
      // the reducer currently considers live is stale by construction
      // (either it lagged behind a phase advance, or arrived out of order)
      // and must be ignored outright rather than applied — never stored,
      // never allowed to move the rep's script position.
      if (action.phaseId !== state.currentPhaseId) return state;
      // Line addressing (both index and exact text) has no stable identity
      // across a script edit — a cursor produced against a different
      // scriptVersion than this client's loaded script must be discarded
      // outright, never stored and later "clamped" into range at render
      // time. Checked here (not just at resolution) so a stray
      // wrong-version event can never overwrite a still-good stored cursor.
      if (action.scriptVersion !== CLOSR_SCRIPT.version) return state;
      return {
        ...state,
        connected: true,
        lastEventAt: action.ts,
        cursor: {
          phaseId: action.phaseId,
          branchTag: action.branchTag,
          variantKey: action.variantKey,
          lineIndex: action.lineIndex,
          lineText: action.lineText,
          scriptVersion: action.scriptVersion,
          ts: action.ts,
        },
      };
    }
    case "dismiss_objection":
      return {
        ...state,
        objectionCards: state.objectionCards.filter((card) => card.id !== action.cardId),
      };
    case "dismiss_nudge":
      return {
        ...state,
        nudges: state.nudges.filter((nudge) => nudge.id !== action.nudgeId),
      };
    case "override_phase":
      return {
        ...state,
        overriddenPhaseId: action.phaseId,
      };
    case "set_entry_field":
      return {
        ...state,
        entryFields: { ...state.entryFields, [action.field]: action.value.trim() || null },
      };
    case "reset":
      return initialCoachState(action.startingPhaseId);
    default:
      return state;
  }
}
