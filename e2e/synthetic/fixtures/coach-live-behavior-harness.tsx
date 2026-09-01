import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { KeyedCoachLiveView } from "@/components/coach/keyed-coach-live-view";
import type {
  CoachRecommendationRequest,
  CoachRecommendationResult,
} from "@/lib/coach/recommendation-types";
import { useCoachSession, type PreparedCoachTarget } from "@/lib/coach/use-coach-session";
import type { CoachCallContext } from "@/lib/coach/types";
import type { DtmfDigit } from "@/lib/dialer/transport";

import {
  configureSyntheticCoachContext,
  failNextSyntheticCoachContextLoad,
  rejectSyntheticCoachContextLoads,
  resolveSyntheticCoachContextLoads,
  setSyntheticCoachContextMode,
  type SyntheticContextMode,
} from "./coach-context-actions-browser-stub";
import { emitSyntheticCoachBroadcast, emitSyntheticCoachStatus } from "./coach-supabase-browser-stub";

const BASE_CONTEXT: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main Street",
  propertyCounty: "Jackson",
  repName: "Jarrad Henry",
  authenticatedRepName: "Jarrad Henry",
  repPhoneE164: "+18165550123",
  motivation: "move closer to family",
  leadId: "abcd1234-ef56-7890-abcd-ef1234c1c524",
  sellerPhoneE164: "+18165559876",
  coldCallerName: "Taylor",
  yearBuilt: "1987",
  leadSource: "cold_call",
  occupancy: "owner_occupied",
};

type ProviderMode = "immediate" | "fast" | "deferred" | "failure";

type DelayedRequest = {
  input: CoachRecommendationRequest;
  resolve: (result: CoachRecommendationResult) => void;
};

declare global {
  interface Window {
    coachBehaviorHarness: Record<string, () => void>;
    coachContextStartupMode?: SyntheticContextMode;
  }
}

// Grounds the canned response in the actual finalized seller transcript sent
// with this specific request, instead of returning static text. A hardcoded
// answer can't distinguish one request from another, which made it
// impossible for a spec to prove a stale/late response was rejected instead
// of merely never checked (both looked identical either way).
function recommendationSuccess(input: CoachRecommendationRequest): CoachRecommendationResult {
  const lastSellerStatement = [...input.transcript]
    .reverse()
    .find((line) => line.speaker === "seller")?.text ?? "your situation";
  return {
    ok: true,
    requestId: input.requestId,
    callId: input.callId,
    activeSectionId: input.activeSectionId,
    mode: input.mode,
    followUpQuestions: [
      `Can you tell me more about "${lastSellerStatement}"?`,
      `How is "${lastSellerStatement}" affecting you right now?`,
      `What happens if "${lastSellerStatement}" does not change?`,
    ],
  };
}

function eventVersion() {
  return { scriptVersion: "1.1.0", matcherVersion: "synthetic" } as const;
}

function BehaviorHarness() {
  const [callNumber, setCallNumber] = useState(1);
  const callId = `synthetic-call-${callNumber}`;
  const preparedTarget: PreparedCoachTarget = callNumber === 1
    ? {
        sellerName: "Prepared Homeowner",
        propertyAddress: "55 Oak Avenue",
        sellerPhoneE164: BASE_CONTEXT.sellerPhoneE164,
        maskedSellerPhone: "+1 (816) 555-9876",
      }
    : {
        sellerName: "Second Prepared Homeowner",
        propertyAddress: "88 Pine Road",
        sellerPhoneE164: BASE_CONTEXT.sellerPhoneE164,
        maskedSellerPhone: "+1 (816) 555-9876",
      };
  const session = useCoachSession(
    callId,
    BASE_CONTEXT.leadId,
    BASE_CONTEXT.sellerPhoneE164,
    BASE_CONTEXT.repPhoneE164,
    true,
    preparedTarget,
  );
  const context = session.contextLoad.context;
  const [open, setOpen] = useState(true);
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
    if (providerModeRef.current !== "fast") {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return recommendationSuccess(input);
  }, []);

  const chooseProviderMode = useCallback((mode: ProviderMode) => {
    providerModeRef.current = mode;
    setProviderMode(mode);
  }, []);

  const emitTranscript = useCallback((speaker: "rep" | "seller", text: string, isFinal: boolean) => {
    session.dispatch({ type: "transcript", speaker, text, isFinal, ts: `synthetic-${Date.now()}-${Math.random()}`, ...eventVersion() });
  }, [session]);

  const startNewCall = useCallback(() => {
    const nextCall = callNumber + 1;
    setCallNumber(nextCall);
    setMuted(false);
    setHeld(false);
    setCallStatus("live");
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
    session.dispatch({ type: "phase", phaseId: "close", ...common });
    session.dispatch({ type: "cursor", phaseId: "introduction", branchTag: "Opener", variantKey: "default", lineIndex: 0, lineText: "legacy", ...common });
    session.dispatch({ type: "cursor", phaseId: "close", branchTag: "If far apart — program pivot", variantKey: "default", lineIndex: 4, lineText: "There is one program I can check to see if you qualify for…", ...common });
    session.dispatch({ type: "objection", objectionId: "price", ...common });
    session.dispatch({ type: "counter", probeCount: 99, ...common });
    session.dispatch({ type: "gate", gateId: "legacy", cleared: true, ...common });
    session.dispatch({ type: "timer", timerId: "legacy", startedAt: common.ts, durationS: 999, ...common });
    session.dispatch({ type: "coach_note", phaseId: "close", text: "Legacy note must remain invisible.", ...common });
    emitSyntheticCoachBroadcast({
      type: "transcript",
      speaker: "seller",
      text: "Legacy-version transcript remains visible.",
      isFinal: true,
      ts: common.ts,
      scriptVersion: "1.0.2",
      matcherVersion: "legacy",
    });
  }, [session]);

  useEffect(() => {
    window.coachBehaviorHarness = {
      sellerInterim: () => emitTranscript("seller", "uh", false),
      sellerFillerFinal: () => emitTranscript("seller", "Okay", true),
      sellerMeaningful: () => emitTranscript("seller", "We need to sell before October because the carrying costs are becoming painful.", true),
      sellerSecondMeaningful: () => emitTranscript("seller", "My job is moving and I cannot afford two homes after next month.", true),
      sellerThirdMeaningful: () => emitTranscript("seller", "The vacant property is draining our savings and we need a clean closing.", true),
      repFinal: () => emitTranscript("rep", "Tell me more about the timing.", true),
      providerImmediate: () => chooseProviderMode("immediate"),
      providerFast: () => chooseProviderMode("fast"),
      providerDeferred: () => chooseProviderMode("deferred"),
      providerFailure: () => chooseProviderMode("failure"),
      resolveDelayed,
      resolveNewestDelayed,
      legacyBatch: emitLegacyBatch,
      reconnect: () => {
        emitSyntheticCoachStatus("CHANNEL_ERROR");
        emitSyntheticCoachStatus("SUBSCRIBED");
      },
      degraded: () => emitSyntheticCoachStatus("CHANNEL_ERROR"),
      contextError: () => {
        failNextSyntheticCoachContextLoad();
        session.retryContext();
      },
      contextDeferred: () => setSyntheticCoachContextMode("deferred"),
      contextImmediate: () => setSyntheticCoachContextMode("immediate"),
      resolveContext: resolveSyntheticCoachContextLoads,
      rejectContext: rejectSyntheticCoachContextLoads,
      newCall: startNewCall,
    };
  }, [chooseProviderMode, emitLegacyBatch, emitTranscript, resolveDelayed, resolveNewestDelayed, session, startNewCall]);

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
configureSyntheticCoachContext(window.coachContextStartupMode ?? "immediate", BASE_CONTEXT);
createRoot(rootElement).render(<BehaviorHarness />);
