"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type {
  CoachRecommendationFailureCode,
  CoachRecommendationMode,
  CoachRecommendationRequestFn,
  CoachRecommendationResult,
  CoachRecommendationTranscriptLine,
} from "./recommendation-types";
import {
  AUTOMATIC_RECOMMENDATION_LIMIT_PER_CALL,
  FOLLOW_UP_RECOMMENDATION_LIMIT_PER_CALL,
  isMeaningfulFinalSellerTurn,
} from "./recommendation-policy";

export const AUTOMATIC_RECOMMENDATION_DEBOUNCE_MS = 1_500;

export type CoachRecommendationClientState = {
  recommendations: string[];
  followUpQuestions: string[];
  loadingMode: CoachRecommendationMode | null;
  error: CoachRecommendationFailureCode | "busy" | null;
  automaticLimitReached: boolean;
  followUpLimitReached: boolean;
};

export type CoachRecommendationContinuity = {
  callId: string | null;
  activeSectionId: string | null;
  lastAutomaticFingerprint: string | null;
  automaticCount: number;
  followUpCount: number;
  state: CoachRecommendationClientState;
};

type TimerApi = {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

export type CoachRecommendationControllerOptions = {
  request: CoachRecommendationRequestFn;
  debounceMs?: number;
  timer?: TimerApi;
  continuity?: CoachRecommendationContinuity;
};

const EMPTY_STATE: CoachRecommendationClientState = {
  recommendations: [],
  followUpQuestions: [],
  loadingMode: null,
  error: null,
  automaticLimitReached: false,
  followUpLimitReached: false,
};

export function createCoachRecommendationContinuity(callId: string | null): CoachRecommendationContinuity {
  return {
    callId,
    activeSectionId: null,
    lastAutomaticFingerprint: null,
    automaticCount: 0,
    followUpCount: 0,
    state: { ...EMPTY_STATE },
  };
}

let requestSequence = 0;
function nextRequestId(): string {
  requestSequence += 1;
  return `coach-recommendation-${Date.now()}-${requestSequence}`;
}

function latestTranscriptFingerprint(lines: readonly CoachRecommendationTranscriptLine[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (isMeaningfulFinalSellerTurn(line)) {
      return `${line.id ?? line.ts ?? index}:${line.text}`;
    }
  }
  return null;
}

export class CoachRecommendationController {
  private readonly request: CoachRecommendationRequestFn;
  private readonly debounceMs: number;
  private readonly timer: TimerApi;
  private readonly continuity: CoachRecommendationContinuity;
  private readonly listeners = new Set<() => void>();
  private state: CoachRecommendationClientState;
  private callId: string | null;
  private activeSectionId: string | null;
  private branchOverrides: Record<string, string> = {};
  private generation = 0;
  private activeRequestToken: symbol | null = null;
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;
  private pendingAutomatic: { fingerprint: string; transcript: CoachRecommendationTranscriptLine[] } | null = null;
  private lastAutomaticFingerprint: string | null = null;
  private automaticCountByCall = new Map<string, number>();
  private followUpCountByCall = new Map<string, number>();

  constructor(options: CoachRecommendationControllerOptions) {
    this.request = options.request;
    this.debounceMs = options.debounceMs ?? AUTOMATIC_RECOMMENDATION_DEBOUNCE_MS;
    this.timer = options.timer ?? { setTimeout, clearTimeout };
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
    this.lastAutomaticFingerprint = this.continuity.lastAutomaticFingerprint;
    if (this.continuity.callId) {
      this.automaticCountByCall.set(this.continuity.callId, this.continuity.automaticCount);
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
    branchOverrides: Record<string, string>;
  }): void {
    const callChanged = input.callId !== this.callId;
    const contextChanged = input.callId !== this.callId || input.activeSectionId !== this.activeSectionId;
    this.callId = input.callId;
    this.activeSectionId = input.activeSectionId;
    this.continuity.callId = input.callId;
    this.continuity.activeSectionId = input.activeSectionId;
    this.branchOverrides = { ...input.branchOverrides };
    if (!contextChanged) return;

    this.generation += 1;
    this.activeRequestToken = null;
    if (callChanged) {
      this.lastAutomaticFingerprint = null;
      this.continuity.lastAutomaticFingerprint = null;
      this.continuity.automaticCount = 0;
      this.continuity.followUpCount = 0;
    }
    this.pendingAutomatic = null;
    if (this.debounceHandle) this.timer.clearTimeout(this.debounceHandle);
    this.debounceHandle = null;
    this.publish({ ...EMPTY_STATE });
  }

  considerAutomatic(transcript: readonly CoachRecommendationTranscriptLine[]): boolean {
    const fingerprint = latestTranscriptFingerprint(transcript);
    if (!fingerprint || fingerprint === this.lastAutomaticFingerprint) return false;
    if (!this.callId || !this.activeSectionId) return false;

    this.lastAutomaticFingerprint = fingerprint;
    this.continuity.lastAutomaticFingerprint = fingerprint;
    this.pendingAutomatic = { fingerprint, transcript: [...transcript] };
    if (this.debounceHandle) this.timer.clearTimeout(this.debounceHandle);
    this.debounceHandle = this.timer.setTimeout(() => {
      this.debounceHandle = null;
      void this.startPendingAutomatic();
    }, this.debounceMs);
    return true;
  }

  private async startPendingAutomatic(): Promise<void> {
    const pending = this.pendingAutomatic;
    if (!pending || this.activeRequestToken) return;
    this.pendingAutomatic = null;
    await this.startRequest("automatic", pending.transcript);
  }

  async requestFollowUp(transcript: readonly CoachRecommendationTranscriptLine[]): Promise<boolean> {
    if (this.activeRequestToken) {
      this.publish({ error: "busy" });
      return false;
    }
    return this.startRequest("follow_up", [...transcript]);
  }

  private async startRequest(
    mode: CoachRecommendationMode,
    transcript: CoachRecommendationTranscriptLine[],
  ): Promise<boolean> {
    const callId = this.callId;
    const activeSectionId = this.activeSectionId;
    if (!callId || !activeSectionId || this.activeRequestToken) return false;

    const counts = mode === "automatic" ? this.automaticCountByCall : this.followUpCountByCall;
    const limit = mode === "automatic"
      ? AUTOMATIC_RECOMMENDATION_LIMIT_PER_CALL
      : FOLLOW_UP_RECOMMENDATION_LIMIT_PER_CALL;
    const count = counts.get(callId) ?? 0;
    if (count >= limit) {
      this.publish({
        error: "rate_limited",
        automaticLimitReached: mode === "automatic" ? true : this.state.automaticLimitReached,
        followUpLimitReached: mode === "follow_up" ? true : this.state.followUpLimitReached,
      });
      return false;
    }

    counts.set(callId, count + 1);
    if (mode === "automatic") this.continuity.automaticCount = count + 1;
    else this.continuity.followUpCount = count + 1;
    const requestId = nextRequestId();
    const generation = this.generation;
    const requestToken = Symbol(requestId);
    this.activeRequestToken = requestToken;
    this.publish({ loadingMode: mode, error: null });

    let result: CoachRecommendationResult;
    try {
      result = await this.request({
        requestId,
        callId,
        activeSectionId,
        branchOverrides: { ...this.branchOverrides },
        mode,
        transcript: transcript.filter((line) => line.isFinal),
      });
    } catch {
      result = { ok: false, requestId, callId, activeSectionId, mode, code: "provider_error" };
    } finally {
      if (this.activeRequestToken === requestToken) this.activeRequestToken = null;
    }

    const stale =
      generation !== this.generation ||
      callId !== this.callId ||
      activeSectionId !== this.activeSectionId ||
      result.requestId !== requestId ||
      result.callId !== callId ||
      result.activeSectionId !== activeSectionId ||
      result.mode !== mode;

    if (!stale) {
      if (result.ok) {
        this.publish({
          loadingMode: null,
          error: null,
          ...(mode === "automatic" ? { recommendations: result.recommendations } : {}),
          ...(mode === "follow_up" ? { followUpQuestions: result.followUpQuestions } : {}),
        });
      } else {
        this.publish({ loadingMode: null, error: result.code });
      }
    }

    if (this.pendingAutomatic && !this.debounceHandle) {
      this.debounceHandle = this.timer.setTimeout(() => {
        this.debounceHandle = null;
        void this.startPendingAutomatic();
      }, 0);
    }
    return !stale && result.ok;
  }

  dispose(): void {
    this.generation += 1;
    this.pendingAutomatic = null;
    if (this.debounceHandle) this.timer.clearTimeout(this.debounceHandle);
    this.debounceHandle = null;
    this.listeners.clear();
  }
}

export type UseCoachRecommendationsInput = {
  callId: string | null;
  activeSectionId: string | null;
  branchOverrides: Record<string, string>;
  transcript: readonly CoachRecommendationTranscriptLine[];
  request: CoachRecommendationRequestFn;
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
      branchOverrides: input.branchOverrides,
    });
    controller.considerAutomatic(input.transcript);
  }, [controller, input.callId, input.activeSectionId, input.branchOverrides, input.transcript]);

  useEffect(() => () => controller.dispose(), [controller]);

  return {
    ...state,
    requestFollowUp: () => controller.requestFollowUp(input.transcript),
  };
}
