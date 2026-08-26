/**
 * Typed shape of closr-script-v0.json (schema_version 2). Every phase and
 * every objection separates two concerns:
 *  - `display`: the approved script — full sentences the rep actually reads
 *    aloud, exactly as written by JT/Jarrad. This is the only source for
 *    "Say" copy in the UI.
 *  - `match`: landmark/objection detection data (short phrase fragments)
 *    consumed by the coach ingest service to recognize where the call is.
 *    Never rendered as spoken content — a fragment like "sound fair" is not
 *    a sentence a rep should read.
 * Kept separate from the runtime CoachEvent contract (types.ts) — this
 * describes the static script, not the live event stream.
 */

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

export type ScriptPhaseMatch = {
  entry_landmarks: ScriptLandmark[];
  advance_landmarks: ScriptLandmark[];
  counters?: ScriptCounter[];
  gates?: ScriptGate[];
  timers?: ScriptTimer[];
  pain_words?: string[];
  exit_to: string | null;
};

/** One spoken sentence/bullet ("say") or a rep-facing stage direction
 * ("note", e.g. "If yes: assume the close.") — notes render dimmed and are
 * never meant to be read aloud. */
export type ScriptLineBlock = { type: "say" | "note"; text: string };

export type ScriptVariant = {
  /** Stable key ("cold_call", "vacant", "default", …) — matched against
   * auto-select context, or picked manually by the rep in the UI. */
  key: string;
  /** Direction label shown above the variant ("Cold call:") — null for a
   * branch's single/default variant. */
  label: string | null;
  /** Optional tone cue tied to the whole variant (e.g. Motivation branch's
   * "concerned / curious tone"), distinct from inline {{tone:}} markup. */
  tone?: string;
  lines: ScriptLineBlock[];
};

export type ScriptBranch = {
  tag: string;
  /** What auto-picks a variant, if anything: "lead_source" | "occupancy".
   * Unrecognized/null values fall back to the rep manually switching. */
  auto_select_by: string | null;
  /** The no-concerns gate box — rendered with a stronger visual treatment. */
  critical?: boolean;
  /** A hold banner shown after this branch (e.g. "3-minute hold — run comps"). */
  hold_after?: string;
  /** A direction note attached to the whole branch, not a specific variant. */
  trailing_note?: string;
  variants: ScriptVariant[];
};

export type ScriptPhaseDisplay = { branches: ScriptBranch[] };

export type ScriptPhase = {
  id: string;
  name: string;
  purpose: string;
  display: ScriptPhaseDisplay;
  match: ScriptPhaseMatch;
  coach_notes: ScriptCoachNote[];
};

export type ScriptObjectionMatch = { triggers: string[] };

export type ScriptObjectionDisplay = {
  tonality: string | null;
  acknowledge: string;
  disarm: string;
  overcome: string;
  template?: boolean;
  template_note?: string;
};

export type ScriptObjection = {
  id: string;
  match: ScriptObjectionMatch;
  display: ScriptObjectionDisplay;
};

export type ClosrScript = {
  schema_version: number;
  version: string;
  source: string;
  brand: { company: string; website: string };
  tokens: string[];
  entry_tokens: string[];
  file_number_rule: { format: string; fallback: string };
  phases: ScriptPhase[];
  objections: ScriptObjection[];
};
