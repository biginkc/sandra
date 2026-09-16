"use client";
import { useCallback, useReducer, useState } from "react";
import { coachReducer, initialCoachState } from "@/lib/coach/event-reducer";
import { createCoachRecommendationContinuity } from "@/lib/coach/recommendation-client";
import type { CoachSession } from "@/lib/coach/use-coach-session";
import {
  FIRST_COACH_SECTION_ID,
  getFirstCoachSectionIdForPhase,
  getNextCoachSectionId,
  getPreviousCoachSectionId,
  getCoachSectionById,
  type CoachSectionId,
} from "@/lib/coach/section-manifest";
import type { CoachCallContext, CoachEntryToken, CoachPhaseId } from "@/lib/coach/types";


const CONTEXT: CoachCallContext = {
  sellerName: "Jane Homeowner", propertyAddress: "123 Main Street",
  propertyCounty: "Jackson", repName: "Jarrad Henry", authenticatedRepName: "Jarrad Henry",
  repPhoneE164: null, sellerPhoneE164: null, leadId: null,
  motivation: "move closer to family", coldCallerName: "Taylor", yearBuilt: "1987",
  leadSource: "cold_call", occupancy: "owner_occupied",
};

// Local equivalent of the session harness: real reducer/navigation, no I/O hooks.
// The parent keys the entire session by call number for a complete reset.
export function usePlaygroundSession(callId: string): CoachSession {
  const [state, dispatch] = useReducer(coachReducer, undefined, () => initialCoachState());
  const [branchOverrides, setBranchOverrides] = useState<Record<string, string>>({});
  const [sectionBranchSelections, setSectionBranchSelections] = useState<Record<string, string>>({});
  const [activeSectionId, setActiveSectionId] = useState<CoachSectionId>(FIRST_COACH_SECTION_ID);
  const [recommendationContinuity] = useState(() => createCoachRecommendationContinuity(callId));
  const retryContext = useCallback(() => undefined, []);
  const selectVariant = useCallback((tag: string, key: string) => {
    setBranchOverrides((prev) => ({ ...prev, [tag]: key }));
  }, []);
  const selectSectionBranch = useCallback((sectionId: CoachSectionId, tag: string) => {
    const section = getCoachSectionById(sectionId);
    if (section && section.content.length > 1 && section.content.some((content) => content.branch_tag === tag)) {
      setSectionBranchSelections((prev) => ({ ...prev, [sectionId]: tag }));
    }
  }, []);
  const setEntryField = useCallback(
    (field: CoachEntryToken, value: string) => dispatch({ type: "set_entry_field", field, value }),
    [dispatch],
  );
  const goToSection = useCallback((sectionId: CoachSectionId) => {
    if (getCoachSectionById(sectionId)) setActiveSectionId(sectionId);
  }, []);
  const goPreviousSection = useCallback(() => {
    setActiveSectionId((current) => getPreviousCoachSectionId(current) ?? current);
  }, []);
  const goNextSection = useCallback(() => {
    setActiveSectionId((current) => getNextCoachSectionId(current) ?? current);
  }, []);
  const goToPhase = useCallback((phaseId: CoachPhaseId) => {
    setActiveSectionId(getFirstCoachSectionIdForPhase(phaseId));
  }, []);

  const previousSectionId = getPreviousCoachSectionId(activeSectionId);
  const nextSectionId = getNextCoachSectionId(activeSectionId);

  return {
    callId,
    recommendationContinuity,
    state,
    degraded: false,
    reconnectGap: false,
    dismissReconnectGap: () => {},
    malformedEventCount: 0,
    scriptOutOfSync: null,
    dispatch,
    contextLoad: { status: "ready", context: CONTEXT },
    retryContext,
    branchOverrides,
    selectVariant,
    sectionBranchSelections,
    selectSectionBranch,
    setEntryField,
    activeSectionId,
    previousSectionId,
    nextSectionId,
    canGoPrevious: previousSectionId !== null,
    canGoNext: nextSectionId !== null,
    goToSection,
    goPreviousSection,
    goNextSection,
    goToPhase,
  };
}
