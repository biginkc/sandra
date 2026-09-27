/** Runtime script helpers. Every function requires the call-bound bundle. */
import {
  buildCoachSectionScriptBlock as buildBundleSectionScriptBlock,
  buildPhaseScriptBlock as buildBundlePhaseScriptBlock,
} from "@biginkc/coach";

export const buildCoachSectionScriptBlock = (...args: Parameters<typeof buildBundleSectionScriptBlock>) => buildBundleSectionScriptBlock(...args);
export const buildPhaseScriptBlock = (...args: Parameters<typeof buildBundlePhaseScriptBlock>) => buildBundlePhaseScriptBlock(...args);

export { branchSayIndex, findNextSayAcrossBranches, getScriptObjection, getScriptPhase, nextPhaseId, resolveCursorLine, resolveCursorNextLine, resolveObjectionOvercome, selectBranchVariantKey } from "@biginkc/coach";
export type { BranchSelectContext, CoachSectionScriptBlock, DisplayLine, PhaseScriptBlock, ResolvedVariant, ScriptBranchBlock } from "@biginkc/coach";
