import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CoachRecommendationController,
  createCoachRecommendationContinuity,
} from "./recommendation-client";
import type {
  CoachRecommendationRequest,
  CoachRecommendationRequestFn,
  CoachRecommendationResult,
  CoachRecommendationTranscriptLine,
} from "./recommendation-types";

const meaningfulTurn = (id: string, text = "The repairs have become too expensive for me."): CoachRecommendationTranscriptLine => ({
  id,
  speaker: "seller",
  text,
  isFinal: true,
});

function success(input: CoachRecommendationRequest): CoachRecommendationResult {
  return {
    ok: true,
    requestId: input.requestId,
    callId: input.callId,
    activeSectionId: input.activeSectionId,
    mode: input.mode,
    recommendations: input.mode === "automatic" ? ["Ask how the repair cost is affecting their timeline."] : [],
    followUpQuestions: input.mode === "follow_up" ? ["What needs repair?", "How long has it been an issue?", "What happens if you wait?"] : [],
  };
}

function makeController(request: CoachRecommendationRequestFn) {
  const controller = new CoachRecommendationController({ request });
  controller.setContext({ callId: "call-1", activeSectionId: "introduction.opener", branchOverrides: {} });
  return controller;
}

describe("CoachRecommendationController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces only a meaningful finalized seller turn for 1.5 seconds and excludes interim lines", async () => {
    const request = vi.fn(async (input: CoachRecommendationRequest) => success(input));
    const controller = makeController(request);

    expect(controller.considerAutomatic([{ speaker: "rep", text: "Tell me more", isFinal: true }])).toBe(false);
    expect(controller.considerAutomatic([{ speaker: "seller", text: "okay", isFinal: true }])).toBe(false);
    expect(controller.considerAutomatic([{ speaker: "seller", text: "The roof has been leaking", isFinal: false }])).toBe(false);
    expect(controller.considerAutomatic([
      { speaker: "rep", text: "interim words", isFinal: false },
      meaningfulTurn("seller-1"),
    ])).toBe(true);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].transcript.every((line) => line.isFinal)).toBe(true);
  });

  it("detects a newly finalized seller turn even when an overlapping rep line remains later in transcript order", async () => {
    const request = vi.fn(async (input: CoachRecommendationRequest) => success(input));
    const controller = makeController(request);
    const overlappedTranscript = [
      meaningfulTurn("seller-1", "The furnace repair is more than I can take on."),
      { id: "rep-1", speaker: "rep" as const, text: "Tell me more about that.", isFinal: true },
    ];

    expect(controller.considerAutomatic(overlappedTranscript)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("allows only one in-flight request and one request per accepted manual click", async () => {
    let resolve!: (value: CoachRecommendationResult) => void;
    const request = vi.fn((input: CoachRecommendationRequest) => new Promise<CoachRecommendationResult>((done) => {
      void input;
      resolve = (value) => done(value);
    }));
    const controller = makeController(request);
    const transcript = [meaningfulTurn("seller-1")];
    const first = controller.requestFollowUp(transcript);
    await Promise.resolve();

    await expect(controller.requestFollowUp(transcript)).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    resolve(success(request.mock.calls[0][0]));
    await expect(first).resolves.toBe(true);
  });

  it("sends the selected section path and rejects a response made stale by a path change", async () => {
    let resolve!: (value: CoachRecommendationResult) => void;
    const request = vi.fn((input: CoachRecommendationRequest) => new Promise<CoachRecommendationResult>((done) => {
      resolve = done;
      void input;
    }));
    const continuity = createCoachRecommendationContinuity("call-1");
    const controller = new CoachRecommendationController({ request, continuity });
    controller.setContext({
      callId: "call-1",
      activeSectionId: "offer.outcome-tracks",
      selectedSectionBranch: "Good news",
      branchOverrides: { "Good news": "default" },
    });

    const pending = controller.requestFollowUp([meaningfulTurn("seller-1")]);
    await Promise.resolve();
    expect(request.mock.calls[0][0].selectedSectionBranch).toBe("Good news");

    controller.setContext({
      callId: "call-1",
      activeSectionId: "offer.outcome-tracks",
      selectedSectionBranch: "Price too low",
      branchOverrides: { "Price too low": "default" },
    });
    resolve(success(request.mock.calls[0][0]));
    await expect(pending).resolves.toBe(false);

    const current = controller.requestFollowUp([meaningfulTurn("seller-2")]);
    await Promise.resolve();
    expect(request.mock.calls[1][0].selectedSectionBranch).toBe("Price too low");
    resolve(success(request.mock.calls[1][0]));
    await expect(current).resolves.toBe(true);

    controller.dispose();
    const reopened = new CoachRecommendationController({ request, continuity });
    reopened.setContext({
      callId: "call-1",
      activeSectionId: "offer.outcome-tracks",
      selectedSectionBranch: "Price too low",
      branchOverrides: { "Price too low": "default" },
    });
    expect(reopened.getSnapshot().followUpQuestions).toHaveLength(3);
  });

  it("lets a deliberate follow-up request supersede background automatic advice", async () => {
    const resolvers: Array<(value: CoachRecommendationResult) => void> = [];
    const request = vi.fn((input: CoachRecommendationRequest) => new Promise<CoachRecommendationResult>((resolve) => {
      void input;
      resolvers.push(resolve);
    }));
    const controller = makeController(request);
    const transcript = [meaningfulTurn("seller-1")];

    expect(controller.considerAutomatic(transcript)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(controller.getSnapshot().loadingMode).toBe("automatic");

    const followUp = controller.requestFollowUp(transcript);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().loadingMode).toBe("follow_up");

    resolvers[0](success(request.mock.calls[0][0]));
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ loadingMode: "follow_up", recommendations: [] });

    resolvers[1](success(request.mock.calls[1][0]));
    await expect(followUp).resolves.toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      loadingMode: null,
      recommendations: [],
      followUpQuestions: expect.any(Array),
    });
    expect(controller.getSnapshot().followUpQuestions).toHaveLength(3);
  });

  it("preserves previous valid output on provider error and a client cap", async () => {
    let fail = false;
    const request = vi.fn(async (input: CoachRecommendationRequest): Promise<CoachRecommendationResult> =>
      fail
        ? { ok: false, requestId: input.requestId, callId: input.callId, activeSectionId: input.activeSectionId, mode: input.mode, code: "provider_error" }
        : success(input),
    );
    const controller = makeController(request);
    const transcript = [meaningfulTurn("seller-1")];

    await controller.requestFollowUp(transcript);
    expect(controller.getSnapshot().followUpQuestions).toHaveLength(3);
    fail = true;
    await controller.requestFollowUp(transcript);
    expect(controller.getSnapshot()).toMatchObject({ followUpQuestions: expect.any(Array), error: "provider_error" });
    expect(controller.getSnapshot().followUpQuestions).toHaveLength(3);

    fail = false;
    for (let index = 2; index < 20; index += 1) await controller.requestFollowUp(transcript);
    await expect(controller.requestFollowUp(transcript)).resolves.toBe(false);
    expect(controller.getSnapshot().followUpQuestions).toHaveLength(3);
    expect(controller.getSnapshot()).toMatchObject({ error: "rate_limited", followUpLimitReached: true });
  });

  it("times out a hung provider request, preserves valid output, and accepts the next request", async () => {
    let hang = false;
    const request = vi.fn((input: CoachRecommendationRequest): Promise<CoachRecommendationResult> =>
      hang ? new Promise(() => undefined) : Promise.resolve(success(input)),
    );
    const controller = new CoachRecommendationController({ request, requestTimeoutMs: 5_000 });
    controller.setContext({ callId: "call-1", activeSectionId: "introduction.opener", branchOverrides: {} });
    const transcript = [meaningfulTurn("seller-1")];

    await controller.requestFollowUp(transcript);
    expect(controller.getSnapshot().followUpQuestions).toHaveLength(3);

    hang = true;
    const timedOut = controller.requestFollowUp(transcript);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(controller.getSnapshot().loadingMode).toBe("follow_up");
    await vi.advanceTimersByTimeAsync(1);
    await expect(timedOut).resolves.toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      loadingMode: null,
      error: "provider_error",
      followUpQuestions: expect.any(Array),
    });
    expect(controller.getSnapshot().followUpQuestions).toHaveLength(3);

    hang = false;
    await expect(controller.requestFollowUp(transcript)).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot()).toMatchObject({ loadingMode: null, error: null });
  });

  it("caps automatic generation at 40 requests for one call", async () => {
    const request = vi.fn(async (input: CoachRecommendationRequest) => success(input));
    const controller = makeController(request);

    for (let index = 0; index < 40; index += 1) {
      expect(controller.considerAutomatic([meaningfulTurn(`seller-${index}`)])).toBe(true);
      await vi.advanceTimersByTimeAsync(1_500);
    }
    expect(request).toHaveBeenCalledTimes(40);

    expect(controller.considerAutomatic([meaningfulTurn("seller-41")])).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(request).toHaveBeenCalledTimes(40);
    expect(controller.getSnapshot()).toMatchObject({ error: "rate_limited", automaticLimitReached: true });
  });

  it("rejects stale responses after a section change and resets section output", async () => {
    let resolve!: (value: CoachRecommendationResult) => void;
    const request = vi.fn((input: CoachRecommendationRequest) => new Promise<CoachRecommendationResult>((done) => {
      void input;
      resolve = done;
    }));
    const controller = makeController(request);
    const pending = controller.requestFollowUp([meaningfulTurn("seller-1")]);
    await Promise.resolve();
    const sent = request.mock.calls[0][0];

    controller.setContext({ callId: "call-1", activeSectionId: "introduction.qualification-frame", branchOverrides: {} });
    expect(controller.getSnapshot()).toEqual(expect.objectContaining({ recommendations: [], followUpQuestions: [], loadingMode: null }));
    resolve(success(sent));
    await expect(pending).resolves.toBe(false);
    expect(controller.getSnapshot().followUpQuestions).toEqual([]);
  });

  it("preserves exhausted per-call caps across section navigation", async () => {
    const request = vi.fn(async (input: CoachRecommendationRequest) => success(input));
    const continuity = createCoachRecommendationContinuity("call-1");
    continuity.automaticCount = 40;
    continuity.followUpCount = 20;
    const controller = new CoachRecommendationController({ request, continuity });
    controller.setContext({ callId: "call-1", activeSectionId: "introduction.opener", branchOverrides: {} });

    expect(controller.getSnapshot()).toMatchObject({
      error: "rate_limited",
      automaticLimitReached: true,
      followUpLimitReached: true,
    });

    controller.setContext({
      callId: "call-1",
      activeSectionId: "introduction.qualification-frame",
      branchOverrides: {},
    });
    expect(controller.getSnapshot()).toMatchObject({
      error: "rate_limited",
      automaticLimitReached: true,
      followUpLimitReached: true,
    });
    await expect(controller.requestFollowUp([meaningfulTurn("seller-1")])).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a response whose echoed request identity does not match", async () => {
    const request = vi.fn(async (input: CoachRecommendationRequest): Promise<CoachRecommendationResult> => ({
      ...success(input),
      requestId: "different-request",
    }));
    const controller = makeController(request);

    await expect(controller.requestFollowUp([meaningfulTurn("seller-1")])).resolves.toBe(false);
    expect(controller.getSnapshot().followUpQuestions).toEqual([]);
  });

  it("does not regenerate the same finalized seller turn after manual section changes or controller remounts", async () => {
    const request = vi.fn(async (input: CoachRecommendationRequest) => success(input));
    const continuity = createCoachRecommendationContinuity("call-1");
    const first = new CoachRecommendationController({ request, continuity });
    first.setContext({ callId: "call-1", activeSectionId: "introduction.opener", branchOverrides: {} });
    const transcript = [meaningfulTurn("seller-1")];

    expect(first.considerAutomatic(transcript)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(request).toHaveBeenCalledTimes(1);

    first.setContext({ callId: "call-1", activeSectionId: "introduction.qualification-frame", branchOverrides: {} });
    expect(first.considerAutomatic(transcript)).toBe(false);
    first.dispose();

    const reopened = new CoachRecommendationController({ request, continuity });
    reopened.setContext({ callId: "call-1", activeSectionId: "introduction.qualification-frame", branchOverrides: {} });
    expect(reopened.considerAutomatic(transcript)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("releases a stale request slot immediately when the call section changes", async () => {
    const resolvers: Array<(value: CoachRecommendationResult) => void> = [];
    const request = vi.fn((input: CoachRecommendationRequest) => new Promise<CoachRecommendationResult>((resolve) => {
      resolvers.push(resolve);
      void input;
    }));
    const controller = makeController(request);
    const transcript = [meaningfulTurn("seller-1")];
    const stale = controller.requestFollowUp(transcript);
    await Promise.resolve();
    const staleInput = request.mock.calls[0][0];

    controller.setContext({
      callId: "call-1",
      activeSectionId: "introduction.qualification-frame",
      branchOverrides: {},
    });
    const current = controller.requestFollowUp(transcript);
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
    const currentInput = request.mock.calls[1][0];
    resolvers[0](success(staleInput));
    await expect(stale).resolves.toBe(false);
    expect(controller.getSnapshot().loadingMode).toBe("follow_up");

    resolvers[1](success(currentInput));
    await expect(current).resolves.toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ loadingMode: null, followUpQuestions: expect.any(Array) });
  });

  it("does not inherit an orphaned busy state when the coach view reopens during a request", async () => {
    const continuity = createCoachRecommendationContinuity("call-1");
    const resolvers: Array<(value: CoachRecommendationResult) => void> = [];
    const request = vi.fn((input: CoachRecommendationRequest) => new Promise<CoachRecommendationResult>((resolve) => {
      resolvers.push(resolve);
      void input;
    }));
    const transcript = [meaningfulTurn("seller-1")];
    const first = new CoachRecommendationController({ request, continuity });
    first.setContext({ callId: "call-1", activeSectionId: "introduction.opener", branchOverrides: {} });
    const stale = first.requestFollowUp(transcript);
    await Promise.resolve();
    const staleInput = request.mock.calls[0][0];
    expect(first.getSnapshot().loadingMode).toBe("follow_up");
    first.dispose();

    const reopened = new CoachRecommendationController({ request, continuity });
    reopened.setContext({ callId: "call-1", activeSectionId: "introduction.opener", branchOverrides: {} });
    expect(reopened.getSnapshot().loadingMode).toBeNull();
    const current = reopened.requestFollowUp(transcript);
    await Promise.resolve();
    const currentInput = request.mock.calls[1][0];
    expect(request).toHaveBeenCalledTimes(2);

    resolvers[0](success(staleInput));
    await expect(stale).resolves.toBe(false);
    expect(reopened.getSnapshot().loadingMode).toBe("follow_up");
    resolvers[1](success(currentInput));
    await expect(current).resolves.toBe(true);
  });
});
