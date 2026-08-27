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
 * describes the static script, not the live event stream. It DOES import
 * COACH_TOKENS/COACH_PHASE_ORDER from types.ts, though: the validator
 * enforces the consumer contract (a script may not declare a token this
 * app can't resolve, or omit a phase the app assumes exists), which
 * requires knowing what the app actually supports.
 */

import { COACH_PHASE_ORDER, COACH_TOKENS } from "./types";

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const SPEAKERS: ReadonlySet<string> = new Set(["rep", "seller"]);
const OCCUPANCY_KEYS: ReadonlySet<string> = new Set(["owner_occupied", "tenant_occupied", "vacant", "unknown"]);

function assertKnownPlaceholders(text: unknown, knownTokens: ReadonlySet<string>, where: string): void {
  if (typeof text !== "string") return; // shape errors are reported by the caller's own check
  const unknown: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("{", cursor);
    const strayClose = text.indexOf("}", cursor);
    if (strayClose >= 0 && (open < 0 || strayClose < open)) {
      throw new Error(`closr-script: ${where} has unmatched brace markup`);
    }
    if (open < 0) break;

    if (text.startsWith("{{", open)) {
      const close = text.indexOf("}}", open + 2);
      if (close < 0) throw new Error(`closr-script: ${where} has unmatched brace markup`);
      const markup = text.slice(open + 2, close);
      if (!/^tone:[^{}]+$/.test(markup)) {
        throw new Error(`closr-script: ${where} has invalid double-brace markup (only {{tone:...}} is supported)`);
      }
      cursor = close + 2;
      continue;
    }

    const close = text.indexOf("}", open + 1);
    if (close < 0) throw new Error(`closr-script: ${where} has unmatched brace markup`);
    const token = text.slice(open + 1, close);
    if (!token || token.includes("{") || token.includes("}")) {
      throw new Error(`closr-script: ${where} has invalid placeholder brace markup`);
    }
    if (!knownTokens.has(token)) unknown.push(token);
    cursor = close + 1;
  }
  if (unknown.length > 0) {
    throw new Error(`closr-script: ${where} references unknown placeholder(s) {${unknown.join("}, {")}}`);
  }
}

function assertValidLandmarks(value: unknown, where: string): void {
  if (!Array.isArray(value)) throw new Error(`closr-script: ${where} is not an array`);
  for (const [index, item] of value.entries()) {
    if (
      !isRecord(item) ||
      !isNonEmptyString(item.id) ||
      typeof item.speaker !== "string" ||
      !SPEAKERS.has(item.speaker) ||
      !isStringArray(item.phrases) ||
      item.phrases.length === 0 ||
      (item.note !== undefined && typeof item.note !== "string")
    ) {
      throw new Error(`closr-script: ${where}[${index}] is malformed (needs id, speaker in rep|seller, non-empty phrases[])`);
    }
  }
}

function assertValidCounters(value: unknown, where: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`closr-script: ${where} is not an array`);
  for (const [index, item] of value.entries()) {
    if (
      !isRecord(item) ||
      !isNonEmptyString(item.id) ||
      !isNonEmptyString(item.counts) ||
      !isFiniteNumber(item.goal) ||
      !isNonEmptyString(item.display)
    ) {
      throw new Error(`closr-script: ${where}[${index}] is malformed (needs id, counts, numeric goal, display)`);
    }
  }
}

function assertValidGates(value: unknown, where: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`closr-script: ${where} is not an array`);
  for (const [index, item] of value.entries()) {
    if (
      !isRecord(item) ||
      !isNonEmptyString(item.id) ||
      typeof item.blocks_exit !== "boolean" ||
      !isNonEmptyString(item.display) ||
      (item.note !== undefined && typeof item.note !== "string") ||
      !isRecord(item.clear_on) ||
      typeof item.clear_on.speaker !== "string" ||
      !SPEAKERS.has(item.clear_on.speaker) ||
      !isStringArray(item.clear_on.phrases) ||
      item.clear_on.phrases.length === 0
    ) {
      throw new Error(
        `closr-script: ${where}[${index}] is malformed (needs id, blocks_exit, display, clear_on.speaker/phrases[])`,
      );
    }
  }
}

function assertValidTimers(value: unknown, where: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`closr-script: ${where} is not an array`);
  for (const [index, item] of value.entries()) {
    if (
      !isRecord(item) ||
      !isNonEmptyString(item.id) ||
      !isStringArray(item.start_on) ||
      item.start_on.length === 0 ||
      !isFiniteNumber(item.duration_s) ||
      !isNonEmptyString(item.display)
    ) {
      throw new Error(`closr-script: ${where}[${index}] is malformed (needs id, non-empty start_on[], numeric duration_s, display)`);
    }
  }
}

function assertValidPainWords(value: unknown, where: string): void {
  if (value === undefined) return;
  if (!isStringArray(value)) throw new Error(`closr-script: ${where} is not a string[]`);
}

/** Fail loud rather than let a malformed script produce silent `undefined`
 * crashes deep in the UI (e.g. `phase.display.branches` on a phase missing
 * `display`). Hand-rolled rather than a schema library — the shape is small
 * and stable, and this only needs to catch structural corruption, not
 * validate every field's semantics.
 *
 * Deliberately does NOT deep-validate every field that exists on the data:
 * only the ones this app actually reads. `counter.display`/`gate.display`/
 * `timer.display` are checked for presence/type but never scanned for
 * `{token}` placeholders — those three fields are never run through
 * resolveDisplayText (the UI builds "Probes N/goal" and "Hold MM:SS"
 * itself from live state), so a `{n}`/`{remaining}` inside them isn't part
 * of the token contract. `coach_notes.text` and
 * `objection.display.template_note` are similarly rendered as raw text,
 * never resolved — see the resolveDisplayText call-site audit in this
 * file's history for the full account of which fields are and aren't
 * resolved. Placeholder checking below covers exactly the fields that ARE:
 * variant line text, branch.trailing_note, and the three objection
 * response strings (including every overcome_by_occupancy value).
 */
export function assertValidClosrScript(data: unknown): asserts data is ClosrScript {
  if (!isRecord(data)) throw new Error("closr-script: root is not an object");
  if (typeof data.schema_version !== "number") throw new Error("closr-script: missing schema_version");
  if (!isNonEmptyString(data.version)) throw new Error("closr-script: missing version");
  if (!isStringArray(data.tokens) || data.tokens.length === 0) throw new Error("closr-script: missing tokens[]");
  const supportedTokens: ReadonlySet<string> = new Set(COACH_TOKENS);
  for (const token of data.tokens) {
    if (!supportedTokens.has(token)) {
      throw new Error(`closr-script: tokens[] declares '${token}', which this app's COACH_TOKENS doesn't support`);
    }
  }
  if (!isRecord(data.file_number_rule) || !isNonEmptyString(data.file_number_rule.format)) {
    throw new Error("closr-script: missing/invalid file_number_rule");
  }
  const knownTokens: ReadonlySet<string> = new Set(data.tokens);

  if (!Array.isArray(data.phases) || data.phases.length === 0) throw new Error("closr-script: missing phases[]");

  // Pre-pass: collect phase ids to reject duplicates and to validate
  // match.exit_to references below, which can point forward to a phase
  // not yet visited in the main per-phase loop's iteration order.
  const phaseIds = new Set<string>();
  for (const phase of data.phases) {
    if (isRecord(phase) && isNonEmptyString(phase.id)) {
      if (phaseIds.has(phase.id)) throw new Error(`closr-script: duplicate phase id '${phase.id}'`);
      phaseIds.add(phase.id);
    }
  }
  for (const requiredPhaseId of COACH_PHASE_ORDER) {
    if (!phaseIds.has(requiredPhaseId)) {
      throw new Error(`closr-script: missing required phase '${requiredPhaseId}' (every id in COACH_PHASE_ORDER must exist)`);
    }
  }
  if (
    data.phases.length !== COACH_PHASE_ORDER.length ||
    data.phases.some((phase, index) => !isRecord(phase) || phase.id !== COACH_PHASE_ORDER[index])
  ) {
    throw new Error("closr-script: phases[] must exactly match COACH_PHASE_ORDER (same ids, order, and length)");
  }

  for (const phase of data.phases) {
    if (!isRecord(phase)) throw new Error("closr-script: a phase entry is not an object");
    if (!isNonEmptyString(phase.id)) throw new Error("closr-script: a phase is missing id");
    const phaseLabel = `phase '${String(phase.id)}'`;
    if (!isNonEmptyString(phase.name)) throw new Error(`closr-script: ${phaseLabel} missing name`);
    if (!isNonEmptyString(phase.purpose)) throw new Error(`closr-script: ${phaseLabel} missing purpose`);
    if (!isRecord(phase.display) || !Array.isArray(phase.display.branches)) {
      throw new Error(`closr-script: ${phaseLabel} missing display.branches[]`);
    }
    const branchTags = new Set<string>();
    for (const branch of phase.display.branches) {
      if (!isRecord(branch) || !isNonEmptyString(branch.tag) || !Array.isArray(branch.variants) || branch.variants.length === 0) {
        throw new Error(`closr-script: ${phaseLabel} has a malformed branch`);
      }
      if (branchTags.has(branch.tag)) throw new Error(`closr-script: ${phaseLabel} has duplicate branch tag '${branch.tag}'`);
      branchTags.add(branch.tag);
      const branchLabel = `${phaseLabel} branch '${String(branch.tag)}'`;
      if (branch.auto_select_by !== null && branch.auto_select_by !== undefined && typeof branch.auto_select_by !== "string") {
        throw new Error(`closr-script: ${branchLabel} has a non-string auto_select_by`);
      }
      if (branch.critical !== undefined && typeof branch.critical !== "boolean") {
        throw new Error(`closr-script: ${branchLabel} has a non-boolean critical`);
      }
      if (branch.hold_after !== undefined && typeof branch.hold_after !== "string") {
        throw new Error(`closr-script: ${branchLabel} has a non-string hold_after`);
      }
      if (branch.trailing_note !== undefined) {
        if (typeof branch.trailing_note !== "string") throw new Error(`closr-script: ${branchLabel} has a non-string trailing_note`);
        assertKnownPlaceholders(branch.trailing_note, knownTokens, `${branchLabel} trailing_note`);
      }
      const variantKeys = new Set<string>();
      for (const variant of branch.variants) {
        if (!isRecord(variant) || !isNonEmptyString(variant.key) || !Array.isArray(variant.lines) || variant.lines.length === 0) {
          throw new Error(`closr-script: ${branchLabel} has a malformed variant`);
        }
        if (variantKeys.has(variant.key)) throw new Error(`closr-script: ${branchLabel} has duplicate variant key '${variant.key}'`);
        variantKeys.add(variant.key);
        if (variant.tone !== undefined && typeof variant.tone !== "string") {
          throw new Error(`closr-script: ${branchLabel} variant '${String(variant.key)}' has a non-string tone`);
        }
        if (variant.label !== null && typeof variant.label !== "string") {
          throw new Error(`closr-script: ${branchLabel} variant '${String(variant.key)}' has a non-string, non-null label`);
        }
        for (const line of variant.lines) {
          if (!isRecord(line) || (line.type !== "say" && line.type !== "note") || !isNonEmptyString(line.text)) {
            throw new Error(`closr-script: ${branchLabel} has a malformed line`);
          }
          assertKnownPlaceholders(line.text, knownTokens, `${branchLabel} variant '${String(variant.key)}' line`);
        }
      }
    }
    if (!isRecord(phase.match)) throw new Error(`closr-script: ${phaseLabel} missing match`);
    assertValidLandmarks(phase.match.entry_landmarks, `${phaseLabel} match.entry_landmarks`);
    assertValidLandmarks(phase.match.advance_landmarks, `${phaseLabel} match.advance_landmarks`);
    assertValidCounters(phase.match.counters, `${phaseLabel} match.counters`);
    assertValidGates(phase.match.gates, `${phaseLabel} match.gates`);
    assertValidTimers(phase.match.timers, `${phaseLabel} match.timers`);
    assertValidPainWords(phase.match.pain_words, `${phaseLabel} match.pain_words`);
    if (phase.match.exit_to !== null && typeof phase.match.exit_to !== "string") {
      throw new Error(`closr-script: ${phaseLabel} match.exit_to must be a string or null`);
    }
    if (typeof phase.match.exit_to === "string" && !phaseIds.has(phase.match.exit_to)) {
      throw new Error(`closr-script: ${phaseLabel} match.exit_to references nonexistent phase '${phase.match.exit_to}'`);
    }
    if (!Array.isArray(phase.coach_notes)) throw new Error(`closr-script: ${phaseLabel} missing coach_notes[]`);
    for (const note of phase.coach_notes) {
      if (
        !isRecord(note) ||
        !isNonEmptyString(note.trigger) ||
        !isNonEmptyString(note.text) ||
        (note.seller_phrases !== undefined && !isStringArray(note.seller_phrases))
      ) {
        throw new Error(`closr-script: ${phaseLabel} has a malformed coach_note`);
      }
    }
  }

  if (!Array.isArray(data.objections) || data.objections.length === 0) throw new Error("closr-script: missing objections[]");
  for (const objection of data.objections) {
    if (!isRecord(objection) || !isNonEmptyString(objection.id)) {
      throw new Error("closr-script: an objection is missing id");
    }
    const objectionLabel = `objection '${String(objection.id)}'`;
    if (!isRecord(objection.match) || !isStringArray(objection.match.triggers) || objection.match.triggers.length === 0) {
      throw new Error(`closr-script: ${objectionLabel} missing match.triggers[]`);
    }
    const display = objection.display;
    if (
      !isRecord(display) ||
      !isNonEmptyString(display.acknowledge) ||
      !isNonEmptyString(display.disarm) ||
      !isNonEmptyString(display.overcome) ||
      (display.tonality !== null && typeof display.tonality !== "string") ||
      (display.template !== undefined && typeof display.template !== "boolean") ||
      (display.template_note !== undefined && typeof display.template_note !== "string")
    ) {
      throw new Error(`closr-script: ${objectionLabel} missing/malformed display fields`);
    }
    assertKnownPlaceholders(display.acknowledge, knownTokens, `${objectionLabel} display.acknowledge`);
    assertKnownPlaceholders(display.disarm, knownTokens, `${objectionLabel} display.disarm`);
    assertKnownPlaceholders(display.overcome, knownTokens, `${objectionLabel} display.overcome`);
    if (display.overcome_by_occupancy !== undefined) {
      if (!isRecord(display.overcome_by_occupancy)) {
        throw new Error(`closr-script: ${objectionLabel} display.overcome_by_occupancy is not an object`);
      }
      for (const [key, value] of Object.entries(display.overcome_by_occupancy)) {
        if (!OCCUPANCY_KEYS.has(key) || typeof value !== "string" || value.length === 0) {
          throw new Error(`closr-script: ${objectionLabel} display.overcome_by_occupancy has a malformed entry '${key}'`);
        }
        assertKnownPlaceholders(value, knownTokens, `${objectionLabel} display.overcome_by_occupancy['${key}']`);
      }
    }
  }
}
