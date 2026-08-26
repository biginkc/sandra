/** Typed shape of closr-script-v0.json. Kept separate from the runtime
 * CoachEvent contract (types.ts) — this describes the static script, not
 * the live event stream. */

export type ScriptLandmark = {
  id: string;
  speaker: "rep" | "seller";
  phrases: string[];
  note?: string;
};

export type ScriptCounter = {
  id: string;
  counts: string;
  goal: number;
  display: string;
};

export type ScriptGate = {
  id: string;
  blocks_exit: boolean;
  clear_on: { speaker: "rep" | "seller"; phrases: string[] };
  display: string;
  note?: string;
};

export type ScriptTimer = {
  id: string;
  start_on: string[];
  duration_s: number;
  display: string;
};

export type ScriptCoachNote = {
  trigger: string;
  text: string;
  seller_phrases?: string[];
};

export type ScriptPhase = {
  id: string;
  name: string;
  entry_landmarks: ScriptLandmark[];
  advance_landmarks: ScriptLandmark[];
  counters?: ScriptCounter[];
  gates?: ScriptGate[];
  timers?: ScriptTimer[];
  pain_words?: string[];
  coach_notes: ScriptCoachNote[];
  exit_to: string | null;
  branch_select?: { by: string; options: string[] };
};

export type ScriptObjection = {
  id: string;
  speaker: "seller";
  triggers: string[];
  tonality: string | null;
  acknowledge: string;
  disarm: string;
  overcome: string;
  template?: boolean;
};

export type ClosrScript = {
  version: string;
  source: string;
  brand: { company: string; website: string };
  tokens: string[];
  file_number_rule: { format: string; fallback: string };
  phases: ScriptPhase[];
  objections: ScriptObjection[];
};
