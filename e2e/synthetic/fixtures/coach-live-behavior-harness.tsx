import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { closrOutbound123Bundle, closrOutbound123Ref } from "@biginkc/coach/fixtures";

import { KeyedCoachLiveView } from "@/components/coach/keyed-coach-live-view";
import { ObjectionPromptProvider } from "@/components/coach/objection-prompt-context";
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
    coachBehaviorHarness: Record<string, () => void | Promise<unknown>>;
    coachContextStartupMode?: SyntheticContextMode;
  }
}

const ACCEPTANCE_WIRE_VERSIONS = {
  scriptVersion: closrOutbound123Bundle.script.version,
  scriptDigest: closrOutbound123Ref.digest,
  matcherVersion: "synthetic",
} as const;

type SyntheticTranscriptEvent = {
  type: "transcript";
  speaker: "rep" | "seller";
  text: string;
  isFinal: boolean;
  ts: string;
};

function acceptanceTranscriptEvents(): SyntheticTranscriptEvent[] {
  const turns: Array<{ speaker: "rep" | "seller"; interim: string; final: string }> = [
    { speaker: "seller", interim: "Hi, thanks for calling", final: "Hi, thanks for calling back." },
    { speaker: "rep", interim: "Absolutely, I wanted to", final: "Absolutely, I wanted to learn what has you considering a move." },
    { speaker: "seller", interim: "We have been thinking", final: "We have been thinking about selling since the job change." },
    { speaker: "rep", interim: "That makes sense, can", final: "That makes sense, can you tell me more about the timing?" },
    { speaker: "seller", interim: "My commute is getting", final: "My commute is getting harder and I want to be closer to family." },
    { speaker: "rep", interim: "Being closer to family", final: "Being closer to family sounds important to you." },
    { speaker: "seller", interim: "Yes, and the repairs", final: "Yes, and the repairs are starting to feel overwhelming." },
    { speaker: "rep", interim: "If the process were", final: "If the process were straightforward, what would a good outcome look like?" },
    { speaker: "seller", interim: "I would like a", final: "I would like a clean sale without putting more money into the house." },
    { speaker: "rep", interim: "We can look at", final: "We can look at an as-is option and walk through the numbers." },
    { speaker: "seller", interim: "The timing matters", final: "The timing matters because my next lease starts in October." },
    { speaker: "rep", interim: "If we can make", final: "If we can make the timing work, would you be open to reviewing an offer?" },
    { speaker: "seller", interim: "I need to think", final: "I need to think about it because I do not want to leave money on the table." },
    { speaker: "rep", interim: "That is fair, the", final: "That is fair, the offer should make sense for your situation." },
    { speaker: "seller", interim: "I would need to", final: "I would need to understand the closing date before deciding." },
    { speaker: "rep", interim: "Let us review the", final: "Let us review the timing and the net proceeds together." },
  ];
  const base = Date.parse("2026-09-29T12:00:00.000Z");
  return turns.flatMap((turn, index) => [
    { type: "transcript" as const, speaker: turn.speaker, text: turn.interim, isFinal: false, ts: new Date(base + index * 1_000).toISOString() },
    { type: "transcript" as const, speaker: turn.speaker, text: turn.final, isFinal: true, ts: new Date(base + index * 1_000 + 500).toISOString() },
  ]).map((event) => ({ ...event, ...ACCEPTANCE_WIRE_VERSIONS }));
}

function objectionPromptEvent(
  label: string,
  sellerTurn: number,
  ts: string,
  scriptDigest = ACCEPTANCE_WIRE_VERSIONS.scriptDigest,
) {
  return {
    type: "objection_prompt" as const,
    objectionId: label === "Timing concern" ? "timing" : "price",
    label,
    sellerTurn,
    classifierModel: "jev-synthetic",
    questionsSha256: "a".repeat(64),
    ts,
    ...ACCEPTANCE_WIRE_VERSIONS,
    scriptDigest,
  };
}

function waitForVisibleText(text: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const deadline = started + 2_000;
    const check = () => {
      const visible = [...document.querySelectorAll<HTMLElement>("[data-testid='transcript-line'], [data-testid='coach-objection-prompt-label']")]
        .some((element) => element.textContent?.includes(text));
      if (visible) {
        resolve(performance.now());
        return;
      }
      if (performance.now() >= deadline) {
        reject(new Error(`Synthetic acceptance text did not become visible: ${text}`));
        return;
      }
      window.requestAnimationFrame(check);
    };
    check();
  });
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
          `Current advice for ${input.callId} in ${input.activeSectionId}.`,
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
  return { scriptVersion: "1.2.0", matcherVersion: "synthetic" } as const;
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

  const replayAcceptanceConversation = useCallback(async () => {
    const events = acceptanceTranscriptEvents();
    const gaps = [180, 220, 260, 320];
    const latencies: number[] = [];
    const receipts: number[] = [];
    const started = performance.now();
    for (const [index, event] of events.entries()) {
      const receipt = performance.now();
      receipts.push(receipt);
      emitSyntheticCoachBroadcast(event, `coach:${callId}`);
      const visible = await waitForVisibleText(event.text);
      latencies.push(visible - receipt);
      if (index < events.length - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, gaps[index % gaps.length]));
      }
    }
    return {
      eventCount: events.length,
      latencies,
      receiptGaps: receipts.slice(1).map((value, index) => value - receipts[index]),
      elapsedMs: performance.now() - started,
    };
  }, [callId]);

  const emitAcceptancePrompt = useCallback((label: string, sellerTurn: number, ts: string, digest?: string) => {
    emitSyntheticCoachBroadcast(
      objectionPromptEvent(label, sellerTurn, ts, digest),
      `coach:${callId}`,
    );
  }, [callId]);

  const measureAcceptancePrompt = useCallback(async () => {
    const receipt = performance.now();
    emitAcceptancePrompt("Price concern", 3, "2026-09-29T12:10:00.000Z");
    const visible = await waitForVisibleText("Price concern");
    return visible - receipt;
  }, [emitAcceptancePrompt]);

  const emitPreviousCallPrompt = useCallback(() => {
    const previousCallId = `synthetic-call-${Math.max(1, callNumber - 1)}`;
    emitSyntheticCoachBroadcast(
      objectionPromptEvent("Previous call", 99, "2026-09-29T12:09:00.000Z"),
      `coach:${previousCallId}`,
    );
  }, [callNumber]);

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
      replayAcceptanceConversation,
      measureAcceptancePrompt,
      newerObjectionPrompt: () => emitAcceptancePrompt("Timing concern", 4, "2026-09-29T12:10:10.000Z"),
      afterDismissObjectionPrompt: () => emitAcceptancePrompt("Timing concern", 5, "2026-09-29T12:10:10.500Z"),
      motivationPrompt: () => emitSyntheticCoachBroadcast({
        type: "motivation_prompt", label: "Motivation", sellerTurn: 4,
        classifierModel: "jev-synthetic", questionsSha256: "a".repeat(64),
        ts: "2026-09-29T12:10:10.000Z", ...ACCEPTANCE_WIRE_VERSIONS,
      }, `coach:${callId}`),
      olderObjectionPrompt: () => emitAcceptancePrompt("Price concern", 3, "2026-09-29T12:10:09.000Z"),
      mismatchedDigestObjectionPrompt: () => emitAcceptancePrompt("Wrong digest", 5, "2026-09-29T12:10:11.000Z", "f".repeat(64)),
      previousCallObjectionPrompt: emitPreviousCallPrompt,
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
  }, [callId, chooseProviderMode, emitAcceptancePrompt, emitLegacyBatch, emitPreviousCallPrompt, emitTranscript, measureAcceptancePrompt, replayAcceptanceConversation, resolveDelayed, resolveNewestDelayed, session, startNewCall]);

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
          />
        </>
      ) : null}
    </>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root for coach behavior harness");
configureSyntheticCoachContext(
  window.coachContextStartupMode ?? "immediate",
  rootElement.dataset.acceptanceTyping === "true"
    ? { ...BASE_CONTEXT, coldCallerName: null }
    : BASE_CONTEXT,
);
createRoot(rootElement).render(
  <ObjectionPromptProvider enabled><BehaviorHarness /></ObjectionPromptProvider>,
);
