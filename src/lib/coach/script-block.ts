import scriptJson from "./closr-script-v0.json";
import { getCoachSectionById, type CoachSectionId } from "./coach-sections";
import { assertValidClosrScript, type ClosrScript, type ScriptBranch, type ScriptLineBlock, type ScriptObjection, type ScriptPhase, type ScriptVariant } from "./script-schema";
import { resolveDisplayText, type DisplayTextSegment } from "./token-resolver";
import type { CoachCallContext, CoachCursor, CoachOccupancy, CoachPhaseId, ResolvedTokens } from "./types";
import { COACH_PHASE_ORDER } from "./types";

// Fail loud at load rather than let a malformed script produce silent
// `undefined` crashes deep in the UI later.
assertValidClosrScript(scriptJson);

export const CLOSR_SCRIPT: ClosrScript = scriptJson;

export function getScriptPhase(phaseId: CoachPhaseId): ScriptPhase | undefined {
  return CLOSR_SCRIPT.phases.find((phase) => phase.id === phaseId);
}

export function getScriptObjection(objectionId: string) {
  return CLOSR_SCRIPT.objections.find((objection) => objection.id === objectionId);
}

/** Picks the objection's overcome text: an occupancy-specific track when
 * the objection declares one and it matches, otherwise the default
 * `overcome`. Occupancy is already known from the coach context (it drives
 * the Reveal phase's Entry branch too), so this needs no manual selector. */
export function resolveObjectionOvercome(objection: ScriptObjection, occupancy: CoachOccupancy | null): string {
  if (occupancy && objection.display.overcome_by_occupancy?.[occupancy]) {
    return objection.display.overcome_by_occupancy[occupancy]!;
  }
  return objection.display.overcome;
}

export function nextPhaseId(phaseId: CoachPhaseId): CoachPhaseId | null {
  const index = COACH_PHASE_ORDER.indexOf(phaseId);
  if (index < 0) return null;
  return COACH_PHASE_ORDER[index + 1] ?? null;
}

/** properties.source values that map cleanly onto a scripted opener variant.
 * Sandra's source enum has no direct "fsbo" value yet, so FSBO leads fall
 * through to the branch's default (name + address) opener. */
const LEAD_SOURCE_TO_VARIANT: Record<string, string> = {
  cold_call: "cold_call",
  sms: "sms",
  driving_for_dollars: "d4d",
};

export type BranchSelectContext = Pick<CoachCallContext, "leadSource" | "occupancy">;

/**
 * Picks which variant of a branch to display: a rep override wins outright;
 * otherwise an auto_select_by branch matches live lead context when
 * possible; otherwise the branch's first variant is the default. Every
 * branch always resolves to *some* variant — the coach stays useful with
 * zero live data.
 */
export function selectBranchVariantKey(
  branch: ScriptBranch,
  selectCtx: BranchSelectContext,
  override: string | null,
): string {
  if (override && branch.variants.some((variant) => variant.key === override)) return override;
  if (branch.auto_select_by === "lead_source" && selectCtx.leadSource) {
    const mapped = LEAD_SOURCE_TO_VARIANT[selectCtx.leadSource];
    if (mapped && branch.variants.some((variant) => variant.key === mapped)) return mapped;
  }
  if (branch.auto_select_by === "occupancy" && selectCtx.occupancy) {
    if (branch.variants.some((variant) => variant.key === selectCtx.occupancy)) return selectCtx.occupancy;
  }
  return branch.variants[0]?.key ?? "default";
}

export type DisplayLine = { id?: string; type: "say" | "note"; segments: DisplayTextSegment[] };

export type ResolvedVariant = {
  key: string;
  label: string | null;
  tone: string | null;
  lines: DisplayLine[];
};

export type ScriptBranchBlock = {
  tag: string;
  critical: boolean;
  holdAfter: string | null;
  trailingNote: DisplayTextSegment[] | null;
  /** Every variant's key/label, for a manual switcher — includes the
   * currently-selected one. */
  variantOptions: { key: string; label: string | null }[];
  autoSelected: boolean;
  selected: ResolvedVariant;
};

export type PhaseScriptBlock = {
  phaseId: CoachPhaseId;
  phaseName: string;
  purpose: string;
  openingCues: string[];
  situationalCues: { trigger: string; text: string }[];
  branches: ScriptBranchBlock[];
  counter: { label: string; goal: number } | null;
  gates: { id: string; display: string }[];
};

const OPENING_TRIGGER = "phase_enter";

function toVariant(variant: ScriptVariant, tokens: ResolvedTokens): ResolvedVariant {
  return {
    key: variant.key,
    label: variant.label,
    tone: variant.tone ?? null,
    lines: variant.lines.map((line) => ({ id: line.id, type: line.type, segments: resolveDisplayText(line.text, tokens) })),
  };
}

function toBranchBlock(
  branch: ScriptBranch,
  tokens: ResolvedTokens,
  selectCtx: BranchSelectContext,
  overrides: Record<string, string>,
): ScriptBranchBlock {
  const overrideKey = overrides[branch.tag] ?? null;
  const selectedKey = selectBranchVariantKey(branch, selectCtx, overrideKey);
  const selectedVariant = branch.variants.find((variant) => variant.key === selectedKey) ?? branch.variants[0];
  const autoSelected = !overrideKey && branch.auto_select_by !== null && selectedKey !== branch.variants[0]?.key;

  return {
    tag: branch.tag,
    critical: branch.critical ?? false,
    holdAfter: branch.hold_after ?? null,
    trailingNote: branch.trailing_note ? resolveDisplayText(branch.trailing_note, tokens) : null,
    variantOptions: branch.variants.map((variant) => ({ key: variant.key, label: variant.label })),
    autoSelected,
    selected: toVariant(selectedVariant, tokens),
  };
}

/** Builds the full display block for one phase: every branch resolved to
 * its selected variant (auto-picked from live context, or manually
 * overridden), tokens filled in, coach notes sorted into "opening" vs
 * "situational", and the phase's counter/gate metadata. Returns null for an
 * unknown phase id.
 *
 * `branchOverrides` maps a branch tag to a rep-picked variant key (from the
 * manual variant switcher) — keys not present fall back to auto-select or
 * the branch's default variant.
 */
export function buildPhaseScriptBlock(
  phaseId: CoachPhaseId,
  tokens: ResolvedTokens,
  selectCtx: BranchSelectContext = { leadSource: null, occupancy: null },
  branchOverrides: Record<string, string> = {},
): PhaseScriptBlock | null {
  const phase = getScriptPhase(phaseId);
  if (!phase) return null;

  const openingCues = phase.coach_notes
    .filter((note) => note.trigger === OPENING_TRIGGER)
    .map((note) => note.text);
  const situationalCues = phase.coach_notes
    .filter((note) => note.trigger !== OPENING_TRIGGER && !note.trigger.startsWith("landmark:"))
    .map((note) => ({ trigger: note.trigger, text: note.text }));

  const counter = phase.match.counters?.[0]
    ? { label: phase.match.counters[0].display, goal: phase.match.counters[0].goal }
    : null;
  const gates = (phase.match.gates ?? []).map((gate) => ({ id: gate.id, display: gate.display }));

  return {
    phaseId,
    phaseName: phase.name,
    purpose: phase.purpose,
    openingCues,
    situationalCues,
    branches: phase.display.branches.map((branch) => toBranchBlock(branch, tokens, selectCtx, branchOverrides)),
    counter,
    gates,
  };
}

export type CoachSectionScriptBlock = {
  sectionId: CoachSectionId;
  phaseId: CoachPhaseId;
  phaseName: string;
  title: string;
  branches: ScriptBranchBlock[];
};

/** Resolves one manual section without copying script text into the manifest. */
export function buildCoachSectionScriptBlock(
  sectionId: CoachSectionId,
  tokens: ResolvedTokens,
  selectCtx: BranchSelectContext = { leadSource: null, occupancy: null },
  branchOverrides: Record<string, string> = {},
): CoachSectionScriptBlock | null {
  const section = getCoachSectionById(sectionId);
  if (!section) return null;
  const phaseBlock = buildPhaseScriptBlock(section.phaseId, tokens, selectCtx, branchOverrides);
  const rawPhase = getScriptPhase(section.phaseId);
  if (!phaseBlock || !rawPhase) return null;

  const branches = section.content.flatMap((contentRef) => {
    const branch = phaseBlock.branches.find((candidate) => candidate.tag === contentRef.branch_tag);
    const rawBranch = rawPhase.display.branches.find((candidate) => candidate.tag === contentRef.branch_tag);
    if (!branch || !rawBranch) return [];
    const variantRef = contentRef.variants.find((candidate) => candidate.variant_key === branch.selected.key);
    const rawVariant = rawBranch.variants.find((candidate) => candidate.key === branch.selected.key);
    if (!variantRef || !rawVariant) return [];

    const includedIds = new Set(variantRef.line_ids);
    const containsLastAuthoredLine = includedIds.has(rawVariant.lines[rawVariant.lines.length - 1].id);
    return [{
      ...branch,
      holdAfter: containsLastAuthoredLine ? branch.holdAfter : null,
      trailingNote: containsLastAuthoredLine ? branch.trailingNote : null,
      selected: {
        ...branch.selected,
        lines: branch.selected.lines.filter((line) => line.id !== undefined && includedIds.has(line.id)),
      },
    }];
  });

  return {
    sectionId: section.id,
    phaseId: section.phaseId,
    phaseName: phaseBlock.phaseName,
    title: section.title,
    branches,
  };
}

/** A resolved cursor position, expressed as an index into the RAW variant
 * `lines` array — ALWAYS a "say" line (see findSayIndexFrom/branchSayIndex,
 * and resolveCursorPosition's step 7, which returns null rather than ever
 * constructing a position from a note-only variant), so it's safe to
 * resolve directly and to compute "the next line" as lineIndex+1 within
 * that SAME lines array without re-deriving anything. */
type ResolvedCursorPosition = { branchTag: string; variantKey: string; lineIndex: number };

/** Scans forward from `fromIndex` (inclusive) for the next "say" line —
 * never returns a "note" line, matching the rule selectSpokenLine already
 * enforces: a rep-facing stage direction must never render as speech, cursor
 * or not. Returns null only if nothing but notes remain from fromIndex on. */
function findSayIndexFrom(lines: ScriptLineBlock[], fromIndex: number): number | null {
  for (let index = fromIndex; index < lines.length; index += 1) {
    if (lines[index].type === "say") return index;
  }
  return null;
}

/** The variant's first "say" line, or null when the variant genuinely has
 * NONE at all. An all-note variant is not something the schema validator
 * forbids (script-schema.ts only requires a variant to have >=1 line, not
 * >=1 "say" line) — this must be able to signal "nothing spoken here"
 * rather than silently defaulting to index 0, which could be a "note"
 * line. Every caller of this MUST treat null as total resolution failure
 * and fall through to something else entirely — never construct a
 * position from a null result, which would let a rep-facing stage
 * direction render under "Say this". Exported so its all-note behavior can
 * be proven directly against a synthetic fixture: the real script has a
 * "say" line in every variant today, so this specific failure mode cannot
 * be reproduced end-to-end through the real data. */
export function branchSayIndex(lines: ScriptLineBlock[]): number | null {
  return findSayIndexFrom(lines, 0);
}

/**
 * Resolves a cursor event into a position within the CURRENTLY DISPLAYED
 * phase block, following the wire contract's exact fall-through order:
 *
 *  1. `scriptVersion` must match this client's loaded script — line
 *     addressing (both by index and by exact text) has no stable identity
 *     across a script edit, so a version-mismatched cursor is discarded
 *     outright here, never resolved against a script it wasn't produced
 *     from. (The reducer already enforces this before ever storing a
 *     cursor — this is a second, independent check, not a trust of that.)
 *  2. `phaseId` must match the block actually being displayed.
 *  3. `branchTag` must exist WITHIN THAT PHASE's branches — tags are unique
 *     per phase, never globally, so this never looks a tag up across
 *     phases (the same trap `branchOverrides` has, being a flat
 *     tag-keyed Record with no phase scoping).
 *  4. Inside SANDRA'S OWN selected variant for that branch (`branch.selected
 *     .key`, which already IS the rep's manual override when one exists —
 *     `selectBranchVariantKey` checks it first, ahead of auto_select_by),
 *     find the line whose raw text equals `lineText`.
 *  5. RESCUE, and ONLY when there is NO manual override for this branch
 *     (`branchOverrides[cursor.branchTag]` is unset): if `lineText` was
 *     genuinely absent from Sandra's auto-selected variant, that is real
 *     evidence the auto-selection guessed wrong — try the cursor's named
 *     `variantKey` instead, and use it only if `lineText` actually matches
 *     a line there too. A REP'S MANUAL OVERRIDE ALWAYS WINS and is never
 *     second-guessed this way: Jitter cannot see the override, so its
 *     variantKey is not "conflicting evidence," just a guess made blind to
 *     information Sandra has and Jitter doesn't. (Concretely: the rep taps
 *     the FSBO variant tab; Jitter, seeing none of that, guesses
 *     `cold_call`. That guess must never override the rep's own tap.)
 *  6. Else, if `lineIndex` is in range for the resolved variant (Sandra's
 *     own selection — the rescue variant is only ever used when its own
 *     lineText match already resolved step 5), use it.
 *  7. Else fall back to that SAME branch's own first spoken line, within
 *     Sandra's own selected variant (mirrors selectSpokenLine, applied to
 *     the branch the cursor named — not branch 0). If that variant has NO
 *     "say" line at all (an all-note variant — the schema permits this;
 *     it only requires >=1 line, not >=1 spoken one), there is nothing
 *     safe to show: this returns null rather than ever presenting a note
 *     as "the thing to say".
 * Steps 4-7 all resolve via findSayIndexFrom/branchSayIndex, so a match
 * landing on (or advancing through) a "note" line is skipped forward to
 * the next "say" line, never rendered as speech.
 *
 * Returns null when the branch itself can't be found in this phase, the
 * version/phase gate fails (step 1/2/3), or step 7's own variant has no
 * spoken line to fall back to — in every case there is nothing this
 * function can safely resolve, so the caller's job is today's FULL
 * fallback (branch 0, first say line via selectSpokenLine), which this
 * function deliberately does not attempt on its own.
 */
function resolveCursorPosition(
  cursor: Pick<CoachCursor, "phaseId" | "branchTag" | "variantKey" | "lineIndex" | "lineText" | "scriptVersion">,
  block: PhaseScriptBlock,
  branchOverrides: Record<string, string>,
): ResolvedCursorPosition | null {
  if (cursor.scriptVersion !== CLOSR_SCRIPT.version) return null; // 1
  if (cursor.phaseId !== block.phaseId) return null; // 2
  const branch = block.branches.find((candidate) => candidate.tag === cursor.branchTag); // 3
  if (!branch) return null;

  const rawBranch = getScriptPhase(cursor.phaseId)?.display.branches.find((candidate) => candidate.tag === cursor.branchTag);
  const sandraVariant = rawBranch?.variants.find((candidate) => candidate.key === branch.selected.key); // Sandra's own selection
  if (!rawBranch || !sandraVariant) return null; // defensive only — block.branches and the raw script should never disagree here

  const sandraTextMatch = sandraVariant.lines.findIndex((line) => line.text === cursor.lineText); // 4
  if (sandraTextMatch >= 0) {
    const resolved = findSayIndexFrom(sandraVariant.lines, sandraTextMatch);
    if (resolved !== null) return { branchTag: branch.tag, variantKey: sandraVariant.key, lineIndex: resolved };
  }

  const hasManualOverride = branchOverrides[cursor.branchTag] !== undefined;
  if (!hasManualOverride && cursor.variantKey !== sandraVariant.key) {
    // 5 — rescue only fires on genuine textual evidence in the cursor's
    // named variant; a bare lineIndex there would just be re-trusting
    // Jitter's guess without proof, the exact thing this rule exists to
    // prevent.
    const cursorVariant = rawBranch.variants.find((candidate) => candidate.key === cursor.variantKey);
    const cursorTextMatch = cursorVariant?.lines.findIndex((line) => line.text === cursor.lineText) ?? -1;
    if (cursorVariant && cursorTextMatch >= 0) {
      const resolved = findSayIndexFrom(cursorVariant.lines, cursorTextMatch);
      if (resolved !== null) return { branchTag: branch.tag, variantKey: cursorVariant.key, lineIndex: resolved };
    }
  }

  if (cursor.lineIndex >= 0 && cursor.lineIndex < sandraVariant.lines.length) {
    // 6
    const resolved = findSayIndexFrom(sandraVariant.lines, cursor.lineIndex);
    if (resolved !== null) return { branchTag: branch.tag, variantKey: sandraVariant.key, lineIndex: resolved };
  }

  // 7 — this branch's own fallback, within Sandra's own variant, never
  // branch 0. If the variant genuinely has no "say" line at all (an
  // all-note variant — not something the schema forbids), there is
  // nothing safe to show here: return null so the caller falls all the
  // way through to today's full branch-0/selectSpokenLine fallback,
  // rather than ever constructing a position that points at a note.
  const fallbackIndex = branchSayIndex(sandraVariant.lines);
  if (fallbackIndex === null) return null;
  return { branchTag: branch.tag, variantKey: sandraVariant.key, lineIndex: fallbackIndex };
}

function displayLineAt(branchTag: string, variantKey: string, lineIndex: number, phaseId: CoachPhaseId, tokens: ResolvedTokens): DisplayLine | null {
  const rawPhase = getScriptPhase(phaseId);
  const line = rawPhase?.display.branches
    .find((candidate) => candidate.tag === branchTag)
    ?.variants.find((candidate) => candidate.key === variantKey)?.lines[lineIndex];
  if (!line) return null;
  return { id: line.id, type: line.type, segments: resolveDisplayText(line.text, tokens) };
}

/** Resolves a cursor event to the exact line to show as "the thing to
 * say," following resolveCursorPosition's fall-through order — see that
 * function's docs for the full algorithm. `branchOverrides` must be the
 * SAME map passed to buildPhaseScriptBlock for this block (a rep's manual
 * variant switch, keyed by branch tag — see resolveCursorPosition's step
 * 5 for why this gates the rescue fallback). Returns null only when the
 * cursor's branch can't be found in the displayed phase, or the
 * version/phase gate fails; the caller falls back to today's full
 * branch-0/first-say-line behavior in that case. */
export function resolveCursorLine(
  cursor: Pick<CoachCursor, "phaseId" | "branchTag" | "variantKey" | "lineIndex" | "lineText" | "scriptVersion">,
  block: PhaseScriptBlock,
  branchOverrides: Record<string, string>,
  tokens: ResolvedTokens,
): DisplayLine | null {
  const position = resolveCursorPosition(cursor, block, branchOverrides);
  if (!position) return null;
  return displayLineAt(position.branchTag, position.variantKey, position.lineIndex, cursor.phaseId, tokens);
}

/** Same resolution as resolveCursorLine, one line further — used for the
 * "Coming next" preview when a cursor is active, so the preview shows the
 * next line within the CURRENT PHASE instead of jumping to the next phase.
 * Built on the position resolveCursorPosition actually landed on (which may
 * differ from the raw cursor.lineIndex, e.g. after a step-7 fallback), not
 * on the cursor's own lineIndex+1, so "next" is always relative to what's
 * actually showing.
 *
 * First looks within the SAME resolved branch/variant. If that variant is
 * exhausted (the cursor is on its last spoken line), continues into the
 * NEXT BRANCH within the same phase — in phase order, using THAT branch's
 * own Sandra-selected variant (never the cursor's, which has no opinion on
 * a branch it didn't name) — so the preview never silently skips ahead to
 * the next PHASE while branches still remain in this one (e.g. a cursor on
 * Introduction's "Frame the call" must preview "Pen & paper — contact
 * details" next, not jump to Reveal). A branch with no "say" line at all
 * is skipped over entirely, never presented as the preview. Only when
 * every remaining branch in this phase has nothing to say does this return
 * null, letting the caller fall through to its own next-PHASE preview. */
export function resolveCursorNextLine(
  cursor: Pick<CoachCursor, "phaseId" | "branchTag" | "variantKey" | "lineIndex" | "lineText" | "scriptVersion">,
  block: PhaseScriptBlock,
  branchOverrides: Record<string, string>,
  tokens: ResolvedTokens,
): DisplayLine | null {
  const position = resolveCursorPosition(cursor, block, branchOverrides);
  if (!position) return null;
  const rawPhase = getScriptPhase(cursor.phaseId);
  if (!rawPhase) return null;

  const variant = rawPhase.display.branches
    .find((candidate) => candidate.tag === position.branchTag)
    ?.variants.find((candidate) => candidate.key === position.variantKey);
  if (variant) {
    const withinVariant = findSayIndexFrom(variant.lines, position.lineIndex + 1);
    if (withinVariant !== null) {
      return { id: variant.lines[withinVariant].id, type: "say", segments: resolveDisplayText(variant.lines[withinVariant].text, tokens) };
    }
  }

  const branchIndex = block.branches.findIndex((candidate) => candidate.tag === position.branchTag);
  if (branchIndex < 0) return null;

  const remainingBranches: BranchLineSource[] = block.branches.slice(branchIndex + 1).flatMap((candidate) => {
    const nextVariant = rawPhase.display.branches
      .find((raw) => raw.tag === candidate.tag)
      ?.variants.find((raw) => raw.key === candidate.selected.key); // Sandra's own selection for THIS branch
    return nextVariant ? [{ tag: candidate.tag, lines: nextVariant.lines }] : [];
  });

  const next = findNextSayAcrossBranches(remainingBranches);
  if (!next) return null;
  const nextLine = remainingBranches.find((candidate) => candidate.tag === next.tag)!.lines[next.lineIndex];
  return { id: nextLine.id, type: "say", segments: resolveDisplayText(nextLine.text, tokens) };
}

/** One phase branch's spoken candidate for cross-branch continuation: its
 * tag (for identification) and the raw lines of whichever variant is
 * actually in play for it (always Sandra's own selection — the cursor has
 * no opinion on a branch it didn't name). Deliberately data-only, not
 * derived from live script/block state, so the skip logic below is
 * directly testable against a synthetic fixture. */
export type BranchLineSource = { tag: string; lines: ScriptLineBlock[] };

/** Scans `branches` IN ORDER (already the remaining branches of the
 * current phase, after the one the cursor resolved to) for the first
 * branch with at least one "say" line, skipping over any branch that is
 * entirely notes — never returns a branch with no spoken line, and never
 * blindly returns the first branch in the list regardless of its content.
 * Used by resolveCursorNextLine for cross-branch continuation (a cursor
 * exhausting one branch's lines must preview the NEXT branch in the
 * phase, not jump straight to the next phase — see that function's docs).
 * Exported and pure specifically so this skip behavior can be proven
 * against a synthetic all-note branch: the real script has a "say" line
 * in every branch today, so this exact skip can't be exercised end-to-end
 * through real data. */
export function findNextSayAcrossBranches(branches: BranchLineSource[]): { tag: string; lineIndex: number } | null {
  for (const branch of branches) {
    const sayIndex = branchSayIndex(branch.lines);
    if (sayIndex !== null) return { tag: branch.tag, lineIndex: sayIndex };
  }
  return null;
}
