"use client";

import { useCallback, useEffect, useState } from "react";

import { loadCoachCallContext } from "./coach-context-actions";
import { createCoachRecommendationContinuity } from "./recommendation-client";
import {
  FIRST_COACH_SECTION_ID,
  getFirstCoachSectionIdForPhase,
  getNextCoachSectionId,
  getPreviousCoachSectionId,
  getCoachSectionById,
  type CoachSectionId,
} from "./section-manifest";
import { useCoachChannel } from "./use-coach-channel";
import type { CoachCallContext, CoachEntryToken, CoachPhaseId } from "./types";

export type ContextLoadState =
  | { status: "loading"; context: CoachCallContext }
  | { status: "ready"; context: CoachCallContext }
  | { status: "error"; context: CoachCallContext };

export type PreparedCoachTarget = {
  repName?: string | null;
  sellerName: string | null;
  propertyAddress: string | null;
  sellerPhoneE164: string | null;
  maskedSellerPhone: string | null;
};

function usablePreparedSellerName(
  value: string | null,
  preparedTarget: PreparedCoachTarget,
): string | null {
  const trimmed = value?.trim();
  if (
    !trimmed
    || trimmed === "Manual dial"
    || trimmed === "Unknown homeowner"
    || trimmed === preparedTarget.sellerPhoneE164?.trim()
    || trimmed === preparedTarget.maskedSellerPhone?.trim()
  ) return null;
  return trimmed;
}

function withPreparedTargetFallbacks(
  context: CoachCallContext,
  preparedTarget: PreparedCoachTarget | null,
): CoachCallContext {
  if (!preparedTarget) return context;
  const preparedAddress = preparedTarget.propertyAddress?.trim() || null;
  return {
    ...context,
    repName: context.repName ?? (preparedTarget.repName?.trim() || null),
    sellerName: context.sellerName ?? usablePreparedSellerName(preparedTarget.sellerName, preparedTarget),
    propertyAddress: context.propertyAddress ?? preparedAddress,
  };
}

function preparedTargetErrorContext(
  sellerPhoneE164: string | null,
  repPhoneE164: string | null,
  preparedTarget: PreparedCoachTarget | null,
): CoachCallContext {
  return {
    sellerName: preparedTarget ? usablePreparedSellerName(preparedTarget.sellerName, preparedTarget) : null,
    propertyAddress: preparedTarget?.propertyAddress?.trim() || null,
    propertyCounty: null,
    repName: preparedTarget?.repName?.trim() || null,
    authenticatedRepName: null,
    repPhoneE164,
    motivation: null,
    leadId: null,
    sellerPhoneE164,
    coldCallerName: null,
    yearBuilt: null,
    leadSource: null,
    occupancy: null,
  };
}

/**
 * Owns the entire coach session — realtime subscription/reducer state,
 * lead context loading, and manual branch-variant overrides — independent
 * of whether the full-screen coach view is currently mounted or collapsed
 * to the classic popover. Call this once at the SoftphoneProvider level,
 * so collapsing the view
 * (which unmounts CoachLiveView) never resets the transcript, phase,
 * gates, objection cards, or rep-entered deal values — only the view
 * itself unmounts, not the session data. The early sessionKey resets local
 * state while callId remains the later, authorization-safe Realtime key.
 */
export function useCoachSession(
  callId: string | null,
  propertyId: string | null,
  sellerPhoneE164: string | null,
  repPhoneE164: string | null,
  livenessActive = true,
  preparedTarget: PreparedCoachTarget | null = null,
  sessionKey: string | null = callId,
) {
  const { dispatch, ...channel } = useCoachChannel(callId, "introduction", livenessActive, sessionKey);
  const [contextLoad, setContextLoad] = useState<ContextLoadState>(() => ({
    status: "loading",
    context: preparedTargetErrorContext(
      sellerPhoneE164,
      repPhoneE164,
      preparedTarget,
    ),
  }));
  const [contextAttempt, setContextAttempt] = useState(0);
  const [branchOverrides, setBranchOverrides] = useState<Record<string, string>>({});
  const [sectionBranchSelections, setSectionBranchSelections] = useState<Record<string, string>>({});
  const [activeSectionId, setActiveSectionId] = useState<CoachSectionId>(FIRST_COACH_SECTION_ID);
  const [recommendationContinuity, setRecommendationContinuity] = useState(
    () => createCoachRecommendationContinuity(sessionKey),
  );

  // A new attempt gets its stable session key before transport.start()
  // resolves and before callId is safe to use for Realtime. Reset from that
  // early key so the connecting view cannot show a previous call's context,
  // while the later null -> callId transition does not reset manual position.
  // branch picks and a stale context/attempt count from a prior call must
  // not leak forward. Adjusted during render (React's documented pattern
  // for resetting state when a prop changes) rather than in an effect, so
  // this doesn't fire an extra render-after-mount for every call.
  const [trackedSessionKey, setTrackedSessionKey] = useState(sessionKey);
  if (sessionKey !== trackedSessionKey) {
    setTrackedSessionKey(sessionKey);
    setContextLoad({
      status: "loading",
      context: preparedTargetErrorContext(
        sellerPhoneE164,
        repPhoneE164,
        preparedTarget,
      ),
    });
    setContextAttempt(0);
    setBranchOverrides({});
    setSectionBranchSelections({});
    setActiveSectionId(FIRST_COACH_SECTION_ID);
    setRecommendationContinuity(createCoachRecommendationContinuity(sessionKey));
  }

  useEffect(() => {
    if (!sessionKey) return;
    let mounted = true;
    loadCoachCallContext({ propertyId, sellerPhoneE164, repPhoneE164 })
      .then((loaded) => {
        if (mounted) {
          setContextLoad({
            status: "ready",
            context: withPreparedTargetFallbacks(loaded, preparedTarget),
          });
        }
      })
      .catch(() => {
        if (mounted) {
          setContextLoad({
            status: "error",
            context: preparedTargetErrorContext(
              sellerPhoneE164,
              repPhoneE164,
              preparedTarget,
            ),
          });
        }
      });
    return () => {
      mounted = false;
    };
    // Resolved once at dial time on purpose — token values shouldn't drift
    // mid-call. contextAttempt is a manual retry knob, not a data
    // dependency; sessionKey gates the whole session's lifetime while callId
    // remains reserved for the later authorized Realtime subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, propertyId, contextAttempt]);

  const retryContext = useCallback(() => setContextAttempt((value) => value + 1), []);
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
    ...channel,
    dispatch,
    contextLoad,
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

export type CoachSession = ReturnType<typeof useCoachSession>;
