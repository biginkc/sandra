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
  /** Default overcome text, used when no occupancy-specific track applies. */
  overcome: string;
  /** Occupancy-specific overcome tracks (e.g. "not_in_rush" branches by
   * owner/tenant/vacant) — keyed by CoachOccupancy. Auto-selected from the
   * coach context's occupancy field; falls back to `overcome` when absent
   * or when the key isn't present. */
  overcome_by_occupancy?: Partial<Record<"owner_occupied" | "tenant_occupied" | "vacant" | "unknown", string>>;
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
  file_number_rule: {
    format: string;
    note: string;
    fallback_if_county_missing: string;
    fallback_if_lead_id_missing_but_county_present: string;
  };
  phases: ScriptPhase[];
  objections: ScriptObjection[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Fail loud rather than let a malformed script produce silent `undefined`
 * crashes deep in the UI (e.g. `phase.display.branches` on a phase missing
 * `display`). Hand-rolled rather than a schema library — the shape is small
 * and stable, and this only needs to catch structural corruption, not
 * validate every field's semantics. */
export function assertValidClosrScript(data: unknown): asserts data is ClosrScript {
  if (!isRecord(data)) throw new Error("closr-script: root is not an object");
  if (typeof data.schema_version !== "number") throw new Error("closr-script: missing schema_version");
  if (!isNonEmptyString(data.version)) throw new Error("closr-script: missing version");
  if (!isStringArray(data.tokens) || data.tokens.length === 0) throw new Error("closr-script: missing tokens[]");
  if (!isRecord(data.file_number_rule) || !isNonEmptyString(data.file_number_rule.format)) {
    throw new Error("closr-script: missing/invalid file_number_rule");
  }
  if (!Array.isArray(data.phases) || data.phases.length === 0) throw new Error("closr-script: missing phases[]");
  for (const phase of data.phases) {
    if (!isRecord(phase)) throw new Error("closr-script: a phase entry is not an object");
    if (!isNonEmptyString(phase.id)) throw new Error("closr-script: a phase is missing id");
    if (!isNonEmptyString(phase.name)) throw new Error(`closr-script: phase '${String(phase.id)}' missing name`);
    if (!isNonEmptyString(phase.purpose)) throw new Error(`closr-script: phase '${String(phase.id)}' missing purpose`);
    if (!isRecord(phase.display) || !Array.isArray(phase.display.branches)) {
      throw new Error(`closr-script: phase '${String(phase.id)}' missing display.branches[]`);
    }
    for (const branch of phase.display.branches) {
      if (!isRecord(branch) || !isNonEmptyString(branch.tag) || !Array.isArray(branch.variants) || branch.variants.length === 0) {
        throw new Error(`closr-script: phase '${String(phase.id)}' has a malformed branch`);
      }
      for (const variant of branch.variants) {
        if (!isRecord(variant) || !isNonEmptyString(variant.key) || !Array.isArray(variant.lines) || variant.lines.length === 0) {
          throw new Error(`closr-script: phase '${String(phase.id)}' branch '${String(branch.tag)}' has a malformed variant`);
        }
        for (const line of variant.lines) {
          if (!isRecord(line) || (line.type !== "say" && line.type !== "note") || !isNonEmptyString(line.text)) {
            throw new Error(`closr-script: phase '${String(phase.id)}' branch '${String(branch.tag)}' has a malformed line`);
          }
        }
      }
    }
    if (!isRecord(phase.match) || !Array.isArray(phase.match.entry_landmarks) || !Array.isArray(phase.match.advance_landmarks)) {
      throw new Error(`closr-script: phase '${String(phase.id)}' missing match.entry_landmarks/advance_landmarks`);
    }
    if (!Array.isArray(phase.coach_notes)) throw new Error(`closr-script: phase '${String(phase.id)}' missing coach_notes[]`);
    for (const note of phase.coach_notes) {
      if (!isRecord(note) || !isNonEmptyString(note.trigger) || !isNonEmptyString(note.text)) {
        throw new Error(`closr-script: phase '${String(phase.id)}' has a malformed coach_note`);
      }
    }
  }
  if (!Array.isArray(data.objections) || data.objections.length === 0) throw new Error("closr-script: missing objections[]");
  for (const objection of data.objections) {
    if (!isRecord(objection) || !isNonEmptyString(objection.id)) {
      throw new Error("closr-script: an objection is missing id");
    }
    if (!isRecord(objection.match) || !isStringArray(objection.match.triggers) || objection.match.triggers.length === 0) {
      throw new Error(`closr-script: objection '${String(objection.id)}' missing match.triggers[]`);
    }
    if (
      !isRecord(objection.display) ||
      !isNonEmptyString(objection.display.acknowledge) ||
      !isNonEmptyString(objection.display.disarm) ||
      !isNonEmptyString(objection.display.overcome)
    ) {
      throw new Error(`closr-script: objection '${String(objection.id)}' missing display.acknowledge/disarm/overcome`);
    }
  }
}
