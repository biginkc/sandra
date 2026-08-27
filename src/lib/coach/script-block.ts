import scriptJson from "./closr-script-v0.json";
import { assertValidClosrScript, type ClosrScript, type ScriptBranch, type ScriptObjection, type ScriptPhase, type ScriptVariant } from "./script-schema";
import { resolveDisplayText, type DisplayTextSegment } from "./token-resolver";
import type { CoachCallContext, CoachOccupancy, CoachPhaseId, ResolvedTokens } from "./types";
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

export type DisplayLine = { type: "say" | "note"; segments: DisplayTextSegment[] };

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
    lines: variant.lines.map((line) => ({ type: line.type, segments: resolveDisplayText(line.text, tokens) })),
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
