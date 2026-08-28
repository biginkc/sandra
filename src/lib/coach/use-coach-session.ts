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
    sellerName: context.sellerName ?? usablePreparedSellerName(preparedTarget.sellerName, preparedTarget),
    propertyAddress: context.propertyAddress ?? preparedAddress,
  };
}

function preparedTargetErrorContext(
  propertyId: string | null,
  sellerPhoneE164: string | null,
  repPhoneE164: string | null,
  preparedTarget: PreparedCoachTarget | null,
): CoachCallContext {
  return {
    sellerName: preparedTarget ? usablePreparedSellerName(preparedTarget.sellerName, preparedTarget) : null,
    propertyAddress: preparedTarget?.propertyAddress?.trim() || null,
    propertyCounty: null,
    repName: null,
    repPhoneE164,
    motivation: null,
    leadId: propertyId,
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
 * keyed only on the call's identity (callId), so collapsing the view
 * (which unmounts CoachLiveView) never resets the transcript, phase,
 * gates, objection cards, or rep-entered deal values — only the view
 * itself unmounts, not the session data.
 */
export function useCoachSession(
  callId: string | null,
  propertyId: string | null,
  sellerPhoneE164: string | null,
  repPhoneE164: string | null,
  livenessActive = true,
  preparedTarget: PreparedCoachTarget | null = null,
) {
  const { dispatch, ...channel } = useCoachChannel(callId, "introduction", livenessActive);
  const [contextLoad, setContextLoad] = useState<ContextLoadState>(() => ({
    status: "loading",
    context: preparedTargetErrorContext(
      propertyId,
      sellerPhoneE164,
      repPhoneE164,
      preparedTarget,
    ),
  }));
  const [contextAttempt, setContextAttempt] = useState(0);
  const [branchOverrides, setBranchOverrides] = useState<Record<string, string>>({});
  const [activeSectionId, setActiveSectionId] = useState<CoachSectionId>(FIRST_COACH_SECTION_ID);
  const [recommendationContinuity, setRecommendationContinuity] = useState(
    () => createCoachRecommendationContinuity(callId),
  );

  // A new call (different callId) must start a clean session — stale
  // branch picks and a stale context/attempt count from a prior call must
  // not leak forward. Adjusted during render (React's documented pattern
  // for resetting state when a prop changes) rather than in an effect, so
  // this doesn't fire an extra render-after-mount for every call.
  const [trackedCallId, setTrackedCallId] = useState(callId);
  if (callId !== trackedCallId) {
    setTrackedCallId(callId);
    setContextLoad({
      status: "loading",
      context: preparedTargetErrorContext(
        propertyId,
        sellerPhoneE164,
        repPhoneE164,
        preparedTarget,
      ),
    });
    setContextAttempt(0);
    setBranchOverrides({});
    setActiveSectionId(FIRST_COACH_SECTION_ID);
    setRecommendationContinuity(createCoachRecommendationContinuity(callId));
  }

  useEffect(() => {
    if (!callId) return;
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
              propertyId,
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
    // dependency; callId gates the whole session's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, propertyId, contextAttempt]);

  const retryContext = useCallback(() => setContextAttempt((value) => value + 1), []);
  const selectVariant = useCallback((tag: string, key: string) => {
    setBranchOverrides((prev) => ({ ...prev, [tag]: key }));
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
