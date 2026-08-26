import scriptJson from "./closr-script-v0.json";
import type { ClosrScript, ScriptLandmark, ScriptPhase } from "./script-schema";
import { resolveScriptText, type ScriptTextSegment } from "./token-resolver";
import type { CoachPhaseId, ResolvedTokens } from "./types";
import { COACH_PHASE_ORDER } from "./types";

export const CLOSR_SCRIPT: ClosrScript = scriptJson as unknown as ClosrScript;

export function getScriptPhase(phaseId: CoachPhaseId): ScriptPhase | undefined {
  return CLOSR_SCRIPT.phases.find((phase) => phase.id === phaseId);
}

export function getScriptObjection(objectionId: string) {
  return CLOSR_SCRIPT.objections.find((objection) => objection.id === objectionId);
}

export function nextPhaseId(phaseId: CoachPhaseId): CoachPhaseId | null {
  const index = COACH_PHASE_ORDER.indexOf(phaseId);
  if (index < 0) return null;
  return COACH_PHASE_ORDER[index + 1] ?? null;
}

export type ScriptLine = {
  id: string;
  speaker: "rep" | "seller";
  segments: ScriptTextSegment[];
  /** Coach note pinned to this exact landmark (trigger: `landmark:{id}`). */
  toneCue: string | null;
};

export type PhaseScriptBlock = {
  phaseId: CoachPhaseId;
  phaseName: string;
  /** Coach notes shown once at the top of the phase (trigger: phase_enter). */
  openingCues: string[];
  /** Coach notes tied to a runtime condition (pain_word, seller_busy, …)
   * rather than a fixed spot in the script — shown as reference, not inline. */
  situationalCues: { trigger: string; text: string }[];
  entryLines: ScriptLine[];
  advanceLines: ScriptLine[];
  counter: { label: string; goal: number } | null;
  gates: { id: string; display: string }[];
};

const OPENING_TRIGGER = "phase_enter";

function toLine(landmark: ScriptLandmark, phase: ScriptPhase, tokens: ResolvedTokens): ScriptLine {
  const toneCue = phase.coach_notes.find((note) => note.trigger === `landmark:${landmark.id}`)?.text ?? null;
  return {
    id: landmark.id,
    speaker: landmark.speaker,
    segments: resolveScriptText(landmark.phrases.join(" / "), tokens),
    toneCue,
  };
}

/** Builds the full display block for one phase: script lines with tokens
 * resolved, coach notes sorted into "opening" vs "situational", and the
 * phase's counter/gate metadata. Returns null for an unknown phase id. */
export function buildPhaseScriptBlock(phaseId: CoachPhaseId, tokens: ResolvedTokens): PhaseScriptBlock | null {
  const phase = getScriptPhase(phaseId);
  if (!phase) return null;

  const openingCues = phase.coach_notes
    .filter((note) => note.trigger === OPENING_TRIGGER)
    .map((note) => note.text);
  const situationalCues = phase.coach_notes
    .filter((note) => note.trigger !== OPENING_TRIGGER && !note.trigger.startsWith("landmark:"))
    .map((note) => ({ trigger: note.trigger, text: note.text }));

  const counter = phase.counters?.[0]
    ? { label: phase.counters[0].display, goal: phase.counters[0].goal }
    : null;
  const gates = (phase.gates ?? []).map((gate) => ({ id: gate.id, display: gate.display }));

  return {
    phaseId,
    phaseName: phase.name,
    openingCues,
    situationalCues,
    entryLines: phase.entry_landmarks.map((landmark) => toLine(landmark, phase, tokens)),
    advanceLines: phase.advance_landmarks.map((landmark) => toLine(landmark, phase, tokens)),
    counter,
    gates,
  };
}
