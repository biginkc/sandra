import type { CoachEvent, CoachPhaseId, CoachState, CoachTranscriptEvent, CoachTranscriptLine } from "./types";

/** Local, client-only actions layered on top of server CoachEvents — never
 * broadcast back to the server, only logged (manual override) or timed out
 * (card dismissal) by the component driving the reducer. */
export type CoachLocalAction =
  | { type: "dismiss_objection"; cardId: string }
  | { type: "override_phase"; phaseId: CoachPhaseId };

export type CoachReducerAction = CoachEvent | CoachLocalAction;

/** Caps in-memory transcript growth for very long calls. */
const MAX_TRANSCRIPT_LINES = 500;

export function initialCoachState(startingPhaseId: CoachPhaseId = "introduction"): CoachState {
  return {
    connected: false,
    currentPhaseId: startingPhaseId,
    overriddenPhaseId: null,
    transcript: [],
    objectionCards: [],
    probeCount: 0,
    gates: {},
    holdTimer: null,
    lastEventAt: null,
  };
}

let transcriptSeq = 0;

/** A live interim result replaces the same speaker's trailing interim line
 * in place; a final either commits that in-place line or, if the last line
 * was already final (or belongs to the other speaker), appends fresh. */
function upsertTranscriptLine(
  transcript: CoachTranscriptLine[],
  event: CoachTranscriptEvent,
): CoachTranscriptLine[] {
  const last = transcript[transcript.length - 1];
  if (last && last.speaker === event.speaker && !last.isFinal) {
    const updated: CoachTranscriptLine = { ...last, text: event.text, isFinal: event.isFinal, ts: event.ts };
    return [...transcript.slice(0, -1), updated];
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
    case "phase":
      return {
        ...state,
        connected: true,
        lastEventAt: action.ts,
        currentPhaseId: action.phaseId,
        // Server truth always wins over a manual rail tap.
        overriddenPhaseId: null,
      };
    case "objection":
      return {
        ...state,
        connected: true,
        lastEventAt: action.ts,
        objectionCards: [
          ...state.objectionCards,
          { id: `${action.objectionId}-${action.ts}-${state.objectionCards.length}`, objectionId: action.objectionId, ts: action.ts },
        ],
      };
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
    case "dismiss_objection":
      return {
        ...state,
        objectionCards: state.objectionCards.filter((card) => card.id !== action.cardId),
      };
    case "override_phase":
      return {
        ...state,
        overriddenPhaseId: action.phaseId,
      };
    default:
      return state;
  }
}
