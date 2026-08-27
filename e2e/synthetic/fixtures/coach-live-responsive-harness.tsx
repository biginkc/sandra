import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { CoachLiveView } from "@/components/coach/coach-live-view";
import { coachReducer, initialCoachState, MAX_NUDGES, MAX_OBJECTION_CARDS } from "@/lib/coach/event-reducer";
import { CLOSR_SCRIPT } from "@/lib/coach/script-block";
import type { DtmfDigit } from "@/lib/dialer/transport";
import type { CoachSession } from "@/lib/coach/use-coach-session";
import type { CoachCallContext, CoachPhaseId, CoachState } from "@/lib/coach/types";

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

function harnessState(withGuidance: boolean): CoachState {
  const state = initialCoachState("offer");
  const expiresAt = Date.now() + 300_000;
  return {
    ...state,
    connected: true,
    transcript: [
      { id: "rep-1", speaker: "rep", text: "Walk me through what has you considering a move.", isFinal: true, ts: "t1" },
      { id: "seller-1", speaker: "seller", text: "We need to be closer to family.", isFinal: true, ts: "t2" },
    ],
    objectionCards: withGuidance
      ? ["price_too_low", "not_in_rush", "end_buyer"].slice(0, MAX_OBJECTION_CARDS).map((objectionId, index) => ({
          id: `${objectionId}-${index}`,
          objectionId,
          ts: `o${index}`,
          expiresAt,
        }))
      : [],
    nudges: withGuidance
      ? ["Slow down.", "Mirror the seller.", "Ask one more question."].slice(0, MAX_NUDGES).map((text, index) => ({
          id: `nudge-${index}`,
          text,
          phaseId: "offer" as const,
          ts: `n${index}`,
          expiresAt,
        }))
      : [],
    gates: { no_concerns: false },
    holdTimer: { timerId: "hold-1", startedAt: new Date().toISOString(), durationS: 300 },
  };
}

declare global {
  interface Window {
    coachHarness: {
      digits: DtmfDigit[];
      showObjection: (objectionId?: string) => void;
      setPhase: (phaseId: CoachPhaseId) => void;
    };
  }
}

function Harness({ withGuidance, held = false }: { withGuidance: boolean; held?: boolean }) {
  const [state, dispatch] = useReducer(coachReducer, withGuidance, harnessState);
  const [reconnectGap, setReconnectGap] = useState(true);
  const digitsRef = useRef<DtmfDigit[]>([]);
  const session = useMemo<CoachSession>(
    () => ({
      state,
      dispatch,
      degraded: false,
      reconnectGap,
      dismissReconnectGap: () => setReconnectGap(false),
      malformedEventCount: 0,
      scriptOutOfSync: "0.9.0",
      contextLoad: { status: "ready", context: sampleContext },
      retryContext: () => {},
      branchOverrides: {},
      selectVariant: () => {},
      setEntryField: (field, value) => dispatch({ type: "set_entry_field", field, value }),
    }),
    [reconnectGap, state],
  );

  useEffect(() => {
    window.coachHarness = {
      digits: digitsRef.current,
      showObjection: (objectionId = "price_too_low") =>
        dispatch({
          type: "objection",
          objectionId,
          ts: `browser-${Date.now()}`,
          scriptVersion: CLOSR_SCRIPT.version,
          matcherVersion: "3",
        }),
      setPhase: (phaseId) =>
        dispatch({
          type: "phase",
          phaseId,
          ts: `browser-${Date.now()}`,
          scriptVersion: CLOSR_SCRIPT.version,
          matcherVersion: "3",
        }),
    };
  }, [dispatch]);

  return (
    <CoachLiveView
      session={session}
      callName="Jane Homeowner"
      callStatus="live"
      seconds={83}
      muted={false}
      held={held}
      holdPending={false}
      onDigit={(digit) => digitsRef.current.push(digit)}
      onMute={() => {}}
      onHold={() => {}}
      onHangup={() => {}}
      onCollapse={() => {}}
    />
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root for coach live responsive harness");
createRoot(rootElement).render(
  <Harness withGuidance={rootElement.dataset.guidance === "true"} held={rootElement.dataset.held === "true"} />,
);
