import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { KeyedCoachLiveView } from "@/components/coach/keyed-coach-live-view";
import { coachReducer, initialCoachState } from "@/lib/coach/event-reducer";
import {
  createCoachRecommendationContinuity,
  type CoachRecommendationContinuity,
} from "@/lib/coach/recommendation-client";
import type {
  CoachRecommendationRequest,
  CoachRecommendationResult,
} from "@/lib/coach/recommendation-types";
import {
  FIRST_COACH_SECTION_ID,
  getFirstCoachSectionIdForPhase,
  getNextCoachSectionId,
  getPreviousCoachSectionId,
  type CoachSectionId,
} from "@/lib/coach/section-manifest";
import type { CoachSession, ContextLoadState } from "@/lib/coach/use-coach-session";
import type { CoachCallContext, CoachEntryToken, CoachPhaseId } from "@/lib/coach/types";
import type { DtmfDigit } from "@/lib/dialer/transport";

const BASE_CONTEXT: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main Street",
  propertyCounty: "Jackson",
  repName: "Jarrad Henry",
  repPhoneE164: "+18165550123",
  motivation: "move closer to family",
  leadId: "lead-ABCD",
  sellerPhoneE164: "+18165559876",
  coldCallerName: "Taylor",
  yearBuilt: "1987",
  leadSource: "cold_call",
  occupancy: "owner_occupied",
};

type ProviderMode = "immediate" | "deferred" | "failure";

type DelayedRequest = {
  input: CoachRecommendationRequest;
  resolve: (result: CoachRecommendationResult) => void;
};

declare global {
  interface Window {
    coachBehaviorHarness: Record<string, () => void>;
  }
}

function recommendationSuccess(input: CoachRecommendationRequest): CoachRecommendationResult {
  return {
    ok: true,
    requestId: input.requestId,
    callId: input.callId,
    activeSectionId: input.activeSectionId,
    mode: input.mode,
    recommendations: input.mode === "automatic"
      ? [
          "Ask how moving closer to family would improve their day-to-day life.",
          "Explore what makes their preferred timeline important.",
        ]
      : [],
    followUpQuestions: input.mode === "follow_up"
      ? [
          "What would moving closer to family make easier for you?",
          "How soon would you ideally like that move to happen?",
          "What is making the timing important right now?",
        ]
      : [],
  };
}

function eventVersion() {
  return { scriptVersion: "1.0.2", matcherVersion: "synthetic" } as const;
}

function BehaviorHarness() {
  const [callNumber, setCallNumber] = useState(1);
  const callId = `synthetic-call-${callNumber}`;
  const [state, dispatch] = useReducer(coachReducer, undefined, () => initialCoachState("introduction"));
  const [activeSectionId, setActiveSectionId] = useState<CoachSectionId>(FIRST_COACH_SECTION_ID);
  const [branchOverrides, setBranchOverrides] = useState<Record<string, string>>({});
  const [context, setContext] = useState(BASE_CONTEXT);
  const contextRef = useRef(BASE_CONTEXT);
  const [contextLoad, setContextLoad] = useState<ContextLoadState>({ status: "ready", context: BASE_CONTEXT });
  const [continuity, setContinuity] = useState<CoachRecommendationContinuity>(() => createCoachRecommendationContinuity(callId));
  const [open, setOpen] = useState(true);
  const [degraded, setDegraded] = useState(false);
  const [reconnectGap, setReconnectGap] = useState(false);
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [callStatus, setCallStatus] = useState<"live" | "ended">("live");
  const [providerMode, setProviderMode] = useState<ProviderMode>("immediate");
  const providerModeRef = useRef(providerMode);
  const delayedRef = useRef<DelayedRequest[]>([]);
  const digitsRef = useRef<DtmfDigit[]>([]);
  const [digits, setDigits] = useState<DtmfDigit[]>([]);
  const [requestCount, setRequestCount] = useState(0);

  useEffect(() => {
    providerModeRef.current = providerMode;
  }, [providerMode]);

  const recommendationRequest = useCallback(async (input: CoachRecommendationRequest): Promise<CoachRecommendationResult> => {
    setRequestCount((value) => value + 1);
    if (providerModeRef.current === "failure") {
      return { ok: false, requestId: input.requestId, callId: input.callId, activeSectionId: input.activeSectionId, mode: input.mode, code: "provider_error" };
    }
    if (providerModeRef.current === "deferred") {
      return new Promise((resolve) => delayedRef.current.push({ input, resolve }));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    return recommendationSuccess(input);
  }, []);

  const chooseProviderMode = useCallback((mode: ProviderMode) => {
    providerModeRef.current = mode;
    setProviderMode(mode);
  }, []);

  const previousSectionId = getPreviousCoachSectionId(activeSectionId);
  const nextSectionId = getNextCoachSectionId(activeSectionId);
  const goPreviousSection = useCallback(() => {
    setActiveSectionId((current) => getPreviousCoachSectionId(current) ?? current);
  }, []);
  const goNextSection = useCallback(() => {
    setActiveSectionId((current) => getNextCoachSectionId(current) ?? current);
  }, []);
  const goToPhase = useCallback((phaseId: CoachPhaseId) => {
    setActiveSectionId(getFirstCoachSectionIdForPhase(phaseId));
  }, []);

  const session = useMemo<CoachSession>(() => ({
    callId,
    recommendationContinuity: continuity,
    state,
    dispatch,
    degraded,
    reconnectGap,
    dismissReconnectGap: () => setReconnectGap(false),
    malformedEventCount: 0,
    scriptOutOfSync: null,
    contextLoad,
    retryContext: () => setContextLoad({ status: "ready", context }),
    branchOverrides,
    selectVariant: (tag: string, key: string) => setBranchOverrides((current) => ({ ...current, [tag]: key })),
    setEntryField: (field: CoachEntryToken, value: string) => dispatch({ type: "set_entry_field", field, value }),
    activeSectionId,
    previousSectionId,
    nextSectionId,
    canGoPrevious: previousSectionId !== null,
    canGoNext: nextSectionId !== null,
    goToSection: setActiveSectionId,
    goPreviousSection,
    goNextSection,
    goToPhase,
  }), [activeSectionId, branchOverrides, callId, context, contextLoad, continuity, degraded, goNextSection, goPreviousSection, goToPhase, nextSectionId, previousSectionId, reconnectGap, state]);

  const emitTranscript = useCallback((speaker: "rep" | "seller", text: string, isFinal: boolean) => {
    dispatch({ type: "transcript", speaker, text, isFinal, ts: `synthetic-${Date.now()}-${Math.random()}`, ...eventVersion() });
  }, []);

  const setContextPatch = useCallback((patch: Partial<CoachCallContext>) => {
    const next = { ...contextRef.current, ...patch };
    contextRef.current = next;
    setContext(next);
    setContextLoad({ status: "ready", context: next });
  }, []);

  const startNewCall = useCallback(() => {
    const nextCall = callNumber + 1;
    const nextId = `synthetic-call-${nextCall}`;
    setCallNumber(nextCall);
    setContinuity(createCoachRecommendationContinuity(nextId));
    dispatch({ type: "reset", startingPhaseId: "introduction" });
    setActiveSectionId(FIRST_COACH_SECTION_ID);
    setBranchOverrides({});
    contextRef.current = BASE_CONTEXT;
    setContext(BASE_CONTEXT);
    setContextLoad({ status: "ready", context: BASE_CONTEXT });
    setMuted(false);
    setHeld(false);
    setCallStatus("live");
    setDegraded(false);
    setReconnectGap(false);
    providerModeRef.current = "immediate";
    setProviderMode("immediate");
    setRequestCount(0);
    digitsRef.current = [];
    setDigits([]);
    setOpen(true);
  }, [callNumber]);

  const resolveDelayed = useCallback(() => {
    const pending = delayedRef.current.shift();
    if (pending) pending.resolve(recommendationSuccess(pending.input));
  }, []);

  const resolveNewestDelayed = useCallback(() => {
    const pending = delayedRef.current.pop();
    if (pending) pending.resolve(recommendationSuccess(pending.input));
  }, []);

  const emitLegacyBatch = useCallback(() => {
    const common = { ts: `legacy-${Date.now()}`, ...eventVersion() };
    dispatch({ type: "phase", phaseId: "close", ...common });
    dispatch({ type: "cursor", phaseId: "introduction", branchTag: "Opener", variantKey: "default", lineIndex: 0, lineText: "legacy", ...common });
    dispatch({ type: "objection", objectionId: "price", ...common });
    dispatch({ type: "counter", probeCount: 99, ...common });
    dispatch({ type: "gate", gateId: "legacy", cleared: true, ...common });
    dispatch({ type: "timer", timerId: "legacy", startedAt: common.ts, durationS: 999, ...common });
    dispatch({ type: "coach_note", phaseId: "close", text: "Legacy note must remain invisible.", ...common });
  }, []);

  useEffect(() => {
    window.coachBehaviorHarness = {
      sellerInterim: () => emitTranscript("seller", "uh", false),
      sellerFillerFinal: () => emitTranscript("seller", "Okay", true),
      sellerMeaningful: () => emitTranscript("seller", "We need to sell before October because the carrying costs are becoming painful.", true),
      sellerSecondMeaningful: () => emitTranscript("seller", "My job is moving and I cannot afford two homes after next month.", true),
      repFinal: () => emitTranscript("rep", "Tell me more about the timing.", true),
      providerImmediate: () => chooseProviderMode("immediate"),
      providerDeferred: () => chooseProviderMode("deferred"),
      providerFailure: () => chooseProviderMode("failure"),
      resolveDelayed,
      resolveNewestDelayed,
      legacyBatch: emitLegacyBatch,
      reconnect: () => setReconnectGap(true),
      degraded: () => setDegraded(true),
      contextError: () => setContextLoad({ status: "error", context: contextRef.current }),
      leadSms: () => setContextPatch({ leadSource: "sms" }),
      occupancyTenant: () => setContextPatch({ occupancy: "tenant_occupied" }),
      occupancyVacant: () => setContextPatch({ occupancy: "vacant" }),
      newCall: startNewCall,
    };
  }, [chooseProviderMode, emitLegacyBatch, emitTranscript, resolveDelayed, resolveNewestDelayed, setContextPatch, startNewCall]);

  return (
    <>
      <div hidden data-testid="synthetic-status">
        <output data-testid="synthetic-request-total">Requests: {requestCount}</output>
        <output data-testid="synthetic-active-call">{callId}</output>
        <output data-testid="synthetic-digits">Digits: {digits.join("")}</output>
      </div>
      {!open ? (
        <main>
          <h1>Coach collapsed</h1>
          <button type="button" data-testid="reopen-coach" onClick={() => setOpen(true)}>Open live coach</button>
          <button type="button" data-testid="collapsed-new-call" onClick={startNewCall}>Start new synthetic call</button>
        </main>
      ) : null}
      {open ? (
        <>
          <KeyedCoachLiveView
            session={session}
            callName={context.sellerName ?? "Homeowner"}
            callStatus={callStatus}
            seconds={83}
            muted={muted}
            held={held}
            holdPending={false}
            onDigit={(digit) => {
              digitsRef.current.push(digit);
              setDigits([...digitsRef.current]);
            }}
            onMute={() => setMuted((value) => !value)}
            onHold={() => setHeld((value) => !value)}
            onHangup={() => setCallStatus("ended")}
            onCollapse={() => setOpen(false)}
            recommendationRequest={recommendationRequest}
          />
        </>
      ) : null}
    </>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root for coach behavior harness");
createRoot(rootElement).render(<BehaviorHarness />);
