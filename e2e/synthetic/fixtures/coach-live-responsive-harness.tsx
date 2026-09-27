import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { CoachLiveView } from "@/components/coach/coach-live-view";
import { createCoachReducer, initialCoachState } from "@/lib/coach/event-reducer";
import {
  getFirstCoachSectionIdForPhase,
  getNextCoachSectionId,
  getPreviousCoachSectionId,
  type CoachSectionId,
} from "@/lib/coach/section-manifest";
import { closrOutbound123Bundle, closrOutbound123Ref } from "@biginkc/coach/fixtures";
import type { DtmfDigit } from "@/lib/dialer/transport";
import type { CoachSession } from "@/lib/coach/use-coach-session";
import type { CoachCallContext, CoachPhaseId, CoachState } from "@/lib/coach/types";
import type { CoachRecommendationRequest, CoachRecommendationResult } from "@/lib/coach/recommendation-types";
import { createCoachRecommendationContinuity } from "@/lib/coach/recommendation-client";

const sampleContext: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: "move closer to family",
  leadId: "lead-1",
  sellerPhoneE164: "+18165559876",
  coldCallerName: null,
  yearBuilt: "1987",
  leadSource: "cold_call",
  occupancy: "owner_occupied",
};

function harnessState(): CoachState {
  const state = initialCoachState("introduction");
  return {
    ...state,
    connected: true,
    holdTimer: { timerId: "hold_timer", startedAt: new Date().toISOString(), durationS: 180 },
    transcript: [
      { id: "rep-1", speaker: "rep", text: "Walk me through what has you considering a move.", isFinal: true, ts: "t1" },
      // Finalized seller speech enables the manual follow-up control, while
      // this intentionally non-meaningful acknowledgement keeps the
      // screenshot harness static instead of starting the 1.5s automatic
      // recommendation timer during multi-pass contrast measurement.
      { id: "seller-1", speaker: "seller", text: "Okay", isFinal: true, ts: "t2" },
    ],
  };
}

declare global {
  interface Window {
    coachHarness: {
      digits: DtmfDigit[];
      setPhase: (phaseId: CoachPhaseId) => void;
      emitLegacyPhase: (phaseId: CoachPhaseId) => void;
    };
  }
}

function Harness({ held: initialHeld = false, interrupted = false, unavailable = false, emptyMotivation = false }: { held?: boolean; interrupted?: boolean; unavailable?: boolean; emptyMotivation?: boolean }) {
  const [held, setHeld] = useState(initialHeld);
  const [state, dispatch] = useReducer(createCoachReducer(closrOutbound123Bundle), undefined, harnessState);
  const [reconnectGap, setReconnectGap] = useState(true);
  const [activeSectionId, setActiveSectionId] = useState<CoachSectionId>(closrOutbound123Bundle.sections.sections[0]!.id);
  const digitsRef = useRef<DtmfDigit[]>([]);
  const goPreviousSection = useCallback(() => {
    setActiveSectionId((current) => getPreviousCoachSectionId(closrOutbound123Bundle, current) ?? current);
  }, []);
  const goNextSection = useCallback(() => {
    setActiveSectionId((current) => getNextCoachSectionId(closrOutbound123Bundle, current) ?? current);
  }, []);
  const goToPhase = useCallback((phaseId: CoachPhaseId) => {
    setActiveSectionId(getFirstCoachSectionIdForPhase(closrOutbound123Bundle, phaseId));
  }, []);
  const previousSectionId = getPreviousCoachSectionId(closrOutbound123Bundle, activeSectionId);
  const nextSectionId = getNextCoachSectionId(closrOutbound123Bundle, activeSectionId);
  const session = useMemo<CoachSession>(
    () => ({
      callId: "synthetic-call",
      scriptBinding: unavailable ? null : { ref: closrOutbound123Ref, bundle: closrOutbound123Bundle },
      scriptBindingStatus: "ready",
      recommendationContinuity: createCoachRecommendationContinuity("synthetic-call"),
      state,
      dispatch,
      degraded: false,
      reconnectGap,
      dismissReconnectGap: () => setReconnectGap(false),
      malformedEventCount: 0,
      scriptOutOfSync: "0.9.0",
      contextLoad: { status: "ready", context: { ...sampleContext, motivation: emptyMotivation ? null : sampleContext.motivation } },
      retryContext: () => {},
      branchOverrides: {},
      selectVariant: () => {},
      sectionBranchSelections: {},
      selectSectionBranch: () => {},
      setEntryField: (field, value) => dispatch({ type: "set_entry_field", field, value }),
      navigatorState: null,
      rememberNavigatorState: () => {},
      activeSectionId,
      previousSectionId,
      nextSectionId,
      canGoPrevious: previousSectionId !== null,
      canGoNext: nextSectionId !== null,
      goToSection: setActiveSectionId,
      goPreviousSection,
      goNextSection,
      goToPhase,
    }),
    [activeSectionId, goNextSection, goPreviousSection, goToPhase, nextSectionId, previousSectionId, reconnectGap, state],
  );

  useEffect(() => {
    window.coachHarness = {
      digits: digitsRef.current,
      setPhase: goToPhase,
      emitLegacyPhase: (phaseId) =>
        dispatch({
          type: "phase",
          phaseId,
          ts: `browser-${Date.now()}`,
          scriptVersion: "1.2.0",
          matcherVersion: "3",
        }),
    };
  }, [dispatch, goToPhase]);

  return (
    <CoachLiveView
      session={session}
      callName="Jane Homeowner"
      callStatus={interrupted ? "audio_reconnect_required" : "live"}
      seconds={83}
      muted={false}
      held={held}
      holdPending={false}
      onDigit={(digit) => digitsRef.current.push(digit)}
      onMute={() => {}}
      onHold={() => setHeld((value) => !value)}
      onHangup={() => { document.getElementById("root")?.setAttribute("data-hungup", "true"); }}
      onReconnectAudio={() => {}}
      onCollapse={() => {}}
      recommendationRequest={async (input: CoachRecommendationRequest): Promise<CoachRecommendationResult> => ({
        ok: true,
        requestId: input.requestId,
        callId: input.callId,
        activeSectionId: input.activeSectionId,
        mode: input.mode,
        recommendations: input.mode === "automatic" ? ["Ask how being closer to family would change their timeline."] : [],
        followUpQuestions: input.mode === "follow_up"
          ? ["What would moving closer to family make easier?", "How soon would you like that move to happen?", "What is making the timing important now?"]
          : [],
      })}
    />
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root for coach live responsive harness");
createRoot(rootElement).render(
  <Harness
    held={rootElement.dataset.held === "true"}
    interrupted={rootElement.dataset.interrupted === "true"}
    unavailable={rootElement.dataset.unavailable === "true"}
    emptyMotivation={rootElement.dataset.emptyMotivation === "true"}
  />,
);
