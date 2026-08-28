import manifestJson from "./closr-sections-v1.json";
import scriptJson from "./closr-script-v0.json";
import {
  assertValidCoachSectionManifest,
  assertValidClosrScript,
  type CoachSectionContentReference,
  type CoachSectionManifest,
  type ClosrScript,
} from "./script-schema";
import type { CoachPhaseId } from "./types";

assertValidClosrScript(scriptJson);
const script: ClosrScript = scriptJson;
assertValidCoachSectionManifest(manifestJson, script);
const manifest: CoachSectionManifest = manifestJson;

/** Stable persisted key for one manually navigable script section. */
export type CoachSectionId = string;

export type CoachSection = {
  id: CoachSectionId;
  phaseId: CoachPhaseId;
  title: string;
  content: readonly CoachSectionContentReference[];
};

export const COACH_SECTION_MANIFEST_VERSION = manifest.version;

/** PDF-aligned manual navigation order. Script copy stays in the script JSON. */
export const COACH_SECTIONS: readonly CoachSection[] = Object.freeze(
  manifest.sections.map((section) =>
    Object.freeze({
      id: section.id,
      phaseId: section.phase_id as CoachPhaseId,
      title: section.title,
      content: section.content,
    }),
  ),
);

export const FIRST_COACH_SECTION_ID: CoachSectionId = COACH_SECTIONS[0].id;

const sectionById = new Map(COACH_SECTIONS.map((section) => [section.id, section]));
const sectionIndexById = new Map(COACH_SECTIONS.map((section, index) => [section.id, index]));

export function getCoachSectionById(id: string | null | undefined): CoachSection | undefined {
  return id ? sectionById.get(id) : undefined;
}

export function getPreviousCoachSectionId(id: string): CoachSectionId | null {
  const index = sectionIndexById.get(id);
  if (index === undefined || index === 0) return null;
  return COACH_SECTIONS[index - 1].id;
}

export function getNextCoachSectionId(id: string): CoachSectionId | null {
  const index = sectionIndexById.get(id);
  if (index === undefined) return null;
  return COACH_SECTIONS[index + 1]?.id ?? null;
}

export function getFirstCoachSectionIdForPhase(phaseId: CoachPhaseId): CoachSectionId {
  return COACH_SECTIONS.find((section) => section.phaseId === phaseId)?.id ?? FIRST_COACH_SECTION_ID;
}
