"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type {
  CoachRecommendationFailureCode,
  CoachRecommendationMode,
  CoachRecommendationRequestFn,
  CoachRecommendationResult,
  CoachRecommendationTranscriptLine,
} from "./recommendation-types";
import { findObjectionHelp, type CoachObjectionHelp } from "./objection-help";
import { FOLLOW_UP_RECOMMENDATION_LIMIT_PER_CALL } from "./recommendation-policy";
import type { CoachOccupancy, ResolvedTokens } from "./types";

export const COACH_RECOMMENDATION_REQUEST_TIMEOUT_MS = 20_000;

export type CoachRecommendationClientState = {
  followUpQuestions: string[];
  /** Explicit, rep-requested help from the validated objection catalog. */
  objectionHelp: CoachObjectionHelp | null;
  loadingMode: CoachRecommendationMode | null;
  error: CoachRecommendationFailureCode | "busy" | null;
  followUpLimitReached: boolean;
};

export type CoachRecommendationContinuity = {
  callId: string | null;
  activeSectionId: string | null;
  selectedSectionBranch: string | null;
  branchOverrides: Record<string, string>;
  followUpCount: number;
  state: CoachRecommendationClientState;
};

type TimerApi = {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

// Browser timer functions are Web IDL methods, not safely detachable plain
// functions. Keeping them directly on an object and later calling
// `timer.setTimeout(...)` changes `this` from Window to that object, which
// Chrome rejects with "Illegal invocation". Wrappers preserve the native
// receiver in the browser and still work in Node-based tests.
const DEFAULT_TIMER_API: TimerApi = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export type CoachRecommendationControllerOptions = {
  request: CoachRecommendationRequestFn;
  requestTimeoutMs?: number;
  timer?: TimerApi;
  continuity?: CoachRecommendationContinuity;
};

const EMPTY_STATE: CoachRecommendationClientState = {
  followUpQuestions: [],
  objectionHelp: null,
  loadingMode: null,
  error: null,
  followUpLimitReached: false,
};

export function createCoachRecommendationContinuity(callId: string | null): CoachRecommendationContinuity {
  return {
    callId,
    activeSectionId: null,
    selectedSectionBranch: null,
    branchOverrides: {},
    followUpCount: 0,
    state: { ...EMPTY_STATE },
  };
}

let requestSequence = 0;
function nextRequestId(): string {
  requestSequence += 1;
  return `coach-recommendation-${Date.now()}-${requestSequence}`;
}

function branchOverridesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

export class CoachRecommendationController {
  private readonly request: CoachRecommendationRequestFn;
  private readonly requestTimeoutMs: number;
  private readonly timer: TimerApi;
  private readonly continuity: CoachRecommendationContinuity;
  private readonly listeners = new Set<() => void>();
  private state: CoachRecommendationClientState;
  private callId: string | null;
  private activeSectionId: string | null;
  private selectedSectionBranch: string | null = null;
  private branchOverrides: Record<string, string> = {};
  private generation = 0;
  private activeRequestToken: symbol | null = null;
  private followUpCountByCall = new Map<string, number>();

  constructor(options: CoachRecommendationControllerOptions) {
    this.request = options.request;
    this.requestTimeoutMs = options.requestTimeoutMs ?? COACH_RECOMMENDATION_REQUEST_TIMEOUT_MS;
    this.timer = options.timer ?? DEFAULT_TIMER_API;
    this.continuity = options.continuity ?? createCoachRecommendationContinuity(null);
    // A view can collapse while a server action is still pending. The old
    // controller invalidates that result on dispose, so a newly mounted view
    // must preserve valid output but never inherit an orphaned loading/busy
    // state for a request it does not own.
    this.state = {
      ...this.continuity.state,
      loadingMode: null,
      error: this.continuity.state.error === "busy" ? null : this.continuity.state.error,
    };
    this.continuity.state = this.state;
    this.callId = this.continuity.callId;
    this.activeSectionId = this.continuity.activeSectionId;
    this.selectedSectionBranch = this.continuity.selectedSectionBranch;
    this.branchOverrides = this.continuity.branchOverrides;
    if (this.continuity.callId) {
      this.followUpCountByCall.set(this.continuity.callId, this.continuity.followUpCount);
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CoachRecommendationClientState => this.state;

  private publish(patch: Partial<CoachRecommendationClientState>): void {
    this.state = { ...this.state, ...patch };
    this.continuity.state = this.state;
    this.listeners.forEach((listener) => listener());
  }

  setContext(input: {
    callId: string | null;
    activeSectionId: string | null;
    selectedSectionBranch?: string | null;
    branchOverrides: Record<string, string>;
  }): void {
    const selectedSectionBranch = input.selectedSectionBranch ?? null;
    const callChanged = input.callId !== this.callId;
    // branchOverrides selects the spoken variant sent to the provider, so a
    // rep switching variants mid-request must invalidate that request the
    // same way a section or call change does — otherwise a response
    // generated for the old variant can render after the new one is chosen.
    const contextChanged =
      input.callId !== this.callId ||
      input.activeSectionId !== this.activeSectionId ||
      selectedSectionBranch !== this.selectedSectionBranch ||
      !branchOverridesEqual(this.branchOverrides, input.branchOverrides);
    this.callId = input.callId;
    this.activeSectionId = input.activeSectionId;
    this.selectedSectionBranch = selectedSectionBranch;
    this.continuity.callId = input.callId;
    this.continuity.activeSectionId = input.activeSectionId;
    this.continuity.selectedSectionBranch = selectedSectionBranch;
    this.branchOverrides = { ...input.branchOverrides };
    this.continuity.branchOverrides = this.branchOverrides;
    if (!contextChanged) return;

    this.generation += 1;
    this.activeRequestToken = null;
    if (callChanged) {
      this.continuity.followUpCount = 0;
    }
    const followUpLimitReached =
      (this.followUpCountByCall.get(input.callId ?? "") ?? 0) >= FOLLOW_UP_RECOMMENDATION_LIMIT_PER_CALL;
    this.publish({
      ...EMPTY_STATE,
      followUpLimitReached,
      error: followUpLimitReached ? "rate_limited" : null,
    });
  }

  async requestFollowUp(transcript: readonly CoachRecommendationTranscriptLine[]): Promise<boolean> {
    if (this.activeRequestToken) {
      this.publish({ error: "busy" });
      return false;
    }
    return this.startRequest([...transcript]);
  }

  /** Objection Help is a synchronous, click-only read of the validated local
   * catalog. It never invokes the provider or changes script/call state. */
  async requestObjectionHelp(
    transcript: readonly CoachRecommendationTranscriptLine[],
    tokens: ResolvedTokens,
    occupancy: CoachOccupancy | null,
  ): Promise<boolean> {
    if (this.activeRequestToken) {
      this.publish({ error: "busy" });
      return false;
    }
    this.publish({
      objectionHelp: findObjectionHelp(transcript, tokens, occupancy),
      error: null,
    });
    return true;
  }

  private async startRequest(transcript: CoachRecommendationTranscriptLine[]): Promise<boolean> {
    const callId = this.callId;
    const activeSectionId = this.activeSectionId;
    const selectedSectionBranch = this.selectedSectionBranch;
    const branchOverrides = this.branchOverrides;
    if (!callId || !activeSectionId || this.activeRequestToken) return false;

    const count = this.followUpCountByCall.get(callId) ?? 0;
    if (count >= FOLLOW_UP_RECOMMENDATION_LIMIT_PER_CALL) {
      this.publish({ error: "rate_limited", followUpLimitReached: true });
      return false;
    }

    this.followUpCountByCall.set(callId, count + 1);
    this.continuity.followUpCount = count + 1;
    const requestId = nextRequestId();
    const generation = this.generation;
    const requestToken = Symbol(requestId);
    this.activeRequestToken = requestToken;
    this.publish({ loadingMode: "follow_up", error: null });

    let result: CoachRecommendationResult;
    let requestTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const requestPromise = this.request({
        requestId,
        callId,
        activeSectionId,
        selectedSectionBranch,
        branchOverrides: { ...this.branchOverrides },
        mode: "follow_up",
        transcript: transcript.filter((line) => line.isFinal),
      });
      const timeoutPromise = new Promise<CoachRecommendationResult>((resolve) => {
        requestTimeoutHandle = this.timer.setTimeout(() => {
          resolve({ ok: false, requestId, callId, activeSectionId, mode: "follow_up", code: "provider_error" });
        }, this.requestTimeoutMs);
      });
      result = await Promise.race([requestPromise, timeoutPromise]);
    } catch {
      result = { ok: false, requestId, callId, activeSectionId, mode: "follow_up", code: "provider_error" };
    } finally {
      if (requestTimeoutHandle) this.timer.clearTimeout(requestTimeoutHandle);
      if (this.activeRequestToken === requestToken) {
        this.activeRequestToken = null;
      }
    }

    const stale =
      generation !== this.generation ||
      callId !== this.callId ||
      activeSectionId !== this.activeSectionId ||
      selectedSectionBranch !== this.selectedSectionBranch ||
      !branchOverridesEqual(branchOverrides, this.branchOverrides) ||
      result.requestId !== requestId ||
      result.callId !== callId ||
      result.activeSectionId !== activeSectionId ||
      result.mode !== "follow_up";

    if (!stale) {
      if (result.ok) {
        this.publish({ loadingMode: null, error: null, followUpQuestions: result.followUpQuestions });
      } else {
        this.publish({ loadingMode: null, error: result.code });
      }
    }

    return !stale && result.ok;
  }

  dispose(): void {
    this.generation += 1;
    this.listeners.clear();
  }
}

export type UseCoachRecommendationsInput = {
  callId: string | null;
  activeSectionId: string | null;
  selectedSectionBranch: string | null;
  branchOverrides: Record<string, string>;
  transcript: readonly CoachRecommendationTranscriptLine[];
  request: CoachRecommendationRequestFn;
  objectionTokens: ResolvedTokens;
  objectionOccupancy: CoachOccupancy | null;
  continuity?: CoachRecommendationContinuity;
};

export function useCoachRecommendations(input: UseCoachRecommendationsInput) {
  const [controller] = useState(() => new CoachRecommendationController({
    request: input.request,
    continuity: input.continuity,
  }));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    controller.setContext({
      callId: input.callId,
      activeSectionId: input.activeSectionId,
      selectedSectionBranch: input.selectedSectionBranch,
      branchOverrides: input.branchOverrides,
    });
    // Follow-up Questions are an explicit rep action. Transcript updates only
    // determine whether the button is eligible; they must never start an AI
    // request on their own.
  }, [controller, input.callId, input.activeSectionId, input.selectedSectionBranch, input.branchOverrides]);

  useEffect(() => () => controller.dispose(), [controller]);

  return {
    ...state,
    requestFollowUp: () => controller.requestFollowUp(input.transcript),
    requestObjectionHelp: () => controller.requestObjectionHelp(input.transcript, input.objectionTokens, input.objectionOccupancy),
  };
}
