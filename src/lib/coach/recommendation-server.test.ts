import { describe, expect, it, vi } from "vitest";

import type { CoachRecommendationRequest } from "./recommendation-types";
import {
  AUTOMATIC_RECOMMENDATION_LIMIT_PER_CALL,
  MAX_RECOMMENDATION_TRANSCRIPT_CHARS,
  MAX_RECOMMENDATION_TRANSCRIPT_LINES,
  boundFinalTranscript,
  createInMemoryCoachRecommendationLimiter,
  loadTrustedSectionContext,
  redactPhoneNumbers,
  requestCoachRecommendationsWithDeps,
  type CoachRecommendationAnthropic,
  type CoachRecommendationServerDeps,
} from "./recommendation-server";

function request(overrides: Partial<CoachRecommendationRequest> = {}): CoachRecommendationRequest {
  return {
    requestId: "request-1",
    callId: "call-1",
    activeSectionId: "introduction.opener",
    branchOverrides: {},
    mode: "automatic",
    transcript: [{ speaker: "seller", text: "I need to sell because the repairs are too expensive.", isFinal: true }],
    ...overrides,
  };
}

function anthropicReturning(input: unknown, capture?: (args: unknown) => void): CoachRecommendationAnthropic {
  const toolName = typeof input === "object" && input !== null && "questions" in input
    ? "submit_follow_up_questions"
    : "submit_coach_recommendations";
  return {
    messages: {
      create: vi.fn(async (args: unknown) => {
        capture?.(args);
        return {
          content: [{ type: "tool_use", id: "tool-1", name: toolName, input }],
        };
      }) as unknown as CoachRecommendationAnthropic["messages"]["create"],
    } as unknown as CoachRecommendationAnthropic["messages"],
  };
}

function deps(overrides: Partial<CoachRecommendationServerDeps> = {}): CoachRecommendationServerDeps {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })),
    },
    calls: {
      findOwnedCall: vi.fn(async () => ({ data: { propertyId: "property-1" }, error: null })),
    },
    contexts: {
      load: vi.fn(async () => ({
        data: {
          sellerName: "Jane Homeowner",
          propertyAddress: "123 Main St",
          propertyCounty: "Jackson",
          yearBuilt: "1987",
          leadSource: "cold_call",
          occupancy: "owner_occupied",
        },
        error: null,
      })),
    },
    anthropic: anthropicReturning({ recommendations: ["Ask how the repair burden has affected their plans."] }),
    limiter: { consume: vi.fn(async () => ({ allowed: true })) },
    ...overrides,
  };
}

describe("coach recommendation server boundary", () => {
  it("authenticates, verifies call ownership, and consumes the mode-specific server limit", async () => {
    const dependencies = deps();
    const result = await requestCoachRecommendationsWithDeps(request(), dependencies);

    expect(result).toMatchObject({ ok: true, mode: "automatic", recommendations: expect.any(Array) });
    expect(dependencies.calls.findOwnedCall).toHaveBeenCalledWith({ callId: "call-1", userId: "user-1" });
    expect(dependencies.contexts.load).toHaveBeenCalledWith({ propertyId: "property-1" });
    expect(dependencies.limiter.consume).toHaveBeenCalledWith({
      userId: "user-1",
      callId: "call-1",
      mode: "automatic",
      limit: AUTOMATIC_RECOMMENDATION_LIMIT_PER_CALL,
    });
  });

  it("rejects unauthenticated and unowned calls before provider use", async () => {
    const anthropic = anthropicReturning({ recommendations: ["unused"] });
    const unauthenticated = deps({
      auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
      anthropic,
    });
    expect(await requestCoachRecommendationsWithDeps(request(), unauthenticated)).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
    expect(anthropic.messages.create).not.toHaveBeenCalled();

    const unowned = deps({
      calls: { findOwnedCall: vi.fn(async () => ({ data: null, error: null })) },
      anthropic,
    });
    expect(await requestCoachRecommendationsWithDeps(request(), unowned)).toMatchObject({
      ok: false,
      code: "call_not_owned",
    });
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it("returns a cap result and never calls the provider when the injected limiter denies", async () => {
    const anthropic = anthropicReturning({ recommendations: ["unused"] });
    const dependencies = deps({ limiter: { consume: vi.fn(async () => ({ allowed: false })) }, anthropic });
    const result = await requestCoachRecommendationsWithDeps(request(), dependencies);

    expect(result).toMatchObject({ ok: false, code: "rate_limited" });
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it("the supplied limiter enforces the exact per-key limit", async () => {
    const limiter = createInMemoryCoachRecommendationLimiter();
    const input = { userId: "u", callId: "c", mode: "automatic" as const, limit: 2 };
    await expect(limiter.consume(input)).resolves.toEqual({ allowed: true });
    await expect(limiter.consume(input)).resolves.toEqual({ allowed: true });
    await expect(limiter.consume(input)).resolves.toEqual({ allowed: false });
    await expect(limiter.consume({ ...input, callId: "other" })).resolves.toEqual({ allowed: true });
  });

  it("rejects interim transcript input and automatic requests without a meaningful final seller turn", async () => {
    const interim = request({ transcript: [{ speaker: "seller", text: "The roof is leaking badly", isFinal: false }] });
    expect(await requestCoachRecommendationsWithDeps(interim, deps())).toMatchObject({ ok: false, code: "invalid_request" });

    const filler = request({ transcript: [{ speaker: "seller", text: "okay", isFinal: true }] });
    expect(await requestCoachRecommendationsWithDeps(filler, deps())).toMatchObject({ ok: false, code: "invalid_request" });

    const repOnlyFollowUp = request({
      mode: "follow_up",
      transcript: [{ speaker: "rep", text: "Tell me more about what has you considering a move.", isFinal: true }],
    });
    expect(await requestCoachRecommendationsWithDeps(repOnlyFollowUp, deps())).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
  });

  it("accepts an automatic request when overlap leaves the finalized seller line before a later rep line", async () => {
    const result = await requestCoachRecommendationsWithDeps(
      request({
        transcript: [
          { speaker: "seller", text: "The furnace repair is more than I can take on.", isFinal: true },
          { speaker: "rep", text: "Tell me more about that.", isFinal: true },
        ],
      }),
      deps(),
    );

    expect(result).toMatchObject({ ok: true, mode: "automatic" });
  });

  it("loads script content by trusted section line references and validates branch variants", () => {
    const context = loadTrustedSectionContext("introduction.opener", { Opener: "cold_call" });
    expect(context).toMatchObject({ phase: "Introduction", sectionTitle: "Open the call" });
    expect(context?.scriptLines.length).toBeGreaterThan(0);
    // The UI stores overrides for the whole call. Overrides from another
    // section are ignored rather than contaminating this section's prompt.
    expect(loadTrustedSectionContext("introduction.opener", { Opener: "cold_call", Entry: "vacant" })).toEqual(context);
    expect(loadTrustedSectionContext("introduction.opener", { Opener: "does-not-exist" })).toBeNull();
    expect(loadTrustedSectionContext("does-not-exist", {})).toBeNull();
  });

  it("bounds to the latest 40 finalized lines and 12,000 formatted characters", () => {
    const lines = Array.from({ length: 50 }, (_, index) => ({
      speaker: "seller" as const,
      text: `${index}-${"x".repeat(400)}`,
      isFinal: true,
    }));
    const bounded = boundFinalTranscript(lines);
    const formattedLength = bounded.reduce((sum, line) => sum + line.speaker.length + 2 + line.text.length, 0);

    expect(bounded.length).toBeLessThanOrEqual(MAX_RECOMMENDATION_TRANSCRIPT_LINES);
    expect(formattedLength).toBeLessThanOrEqual(MAX_RECOMMENDATION_TRANSCRIPT_CHARS);
    expect(bounded.at(-1)?.text.startsWith("49-")).toBe(true);
  });

  it("removes phone numbers before prompting and labels reference data as untrusted", async () => {
    let captured: unknown;
    const dependencies = deps({
      anthropic: anthropicReturning(
        { recommendations: ["Ask how soon they need the repair resolved."] },
        (args) => { captured = args; },
      ),
    });
    const rawPhone = "(816) 555-1212";
    const result = await requestCoachRecommendationsWithDeps(
      request({ transcript: [{ speaker: "seller", text: `Call me at ${rawPhone} because the roof issue is urgent.`, isFinal: true }] }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(rawPhone);
    expect(serialized).toContain("[phone removed]");
    expect(serialized).toContain("untrusted quoted reference data");
    expect(serialized).toContain("123 Main St");
    expect(redactPhoneNumbers("Built in 1987 at 1234 Main St")).toBe("Built in 1987 at 1234 Main St");
  });

  it("returns exactly three distinct follow-up questions and rejects malformed tool output", async () => {
    const good = deps({
      anthropic: {
        messages: {
          create: vi.fn(async () => ({
            content: [{
              type: "tool_use",
              id: "tool-1",
              name: "submit_follow_up_questions",
              input: { questions: [
                { template: "tell_more", groundingPhrase: "repairs are too expensive" },
                { template: "impact", groundingPhrase: "repairs" },
                { template: "priority", groundingPhrase: "repairs" },
              ] },
            }],
          })) as unknown as CoachRecommendationAnthropic["messages"]["create"],
        } as unknown as CoachRecommendationAnthropic["messages"],
      },
    });
    const result = await requestCoachRecommendationsWithDeps(request({ mode: "follow_up" }), good);
    expect(result).toMatchObject({ ok: true, recommendations: [], followUpQuestions: expect.arrayContaining([expect.any(String)]) });
    if (result.ok) expect(result.followUpQuestions).toHaveLength(3);

    const duplicate = deps({
      anthropic: {
        messages: {
          create: vi.fn(async () => ({
            content: [{
              type: "tool_use",
              id: "tool-1",
              name: "submit_follow_up_questions",
              input: { questions: [
                { template: "tell_more", groundingPhrase: "repairs are too expensive" },
                { template: "tell_more", groundingPhrase: "repairs are too expensive" },
                { template: "impact", groundingPhrase: "repairs" },
              ] },
            }],
          })) as unknown as CoachRecommendationAnthropic["messages"]["create"],
        } as unknown as CoachRecommendationAnthropic["messages"],
      },
    });
    expect(await requestCoachRecommendationsWithDeps(request({ mode: "follow_up" }), duplicate)).toMatchObject({
      ok: false,
      code: "provider_error",
    });
  });

  it("separates seller grounding from script context and rejects script-only or falsely attributed premises", async () => {
    let captured: unknown;
    const transcript = [{ speaker: "seller" as const, text: "Audio check. This line repeats once per minute.", isFinal: true }];
    const valid = deps({
      anthropic: anthropicReturning({
        questions: [
          { template: "tell_more", groundingPhrase: "audio check" },
          { template: "why_now", groundingPhrase: "once per minute" },
          { template: "priority", groundingPhrase: "audio check" },
        ],
      }, (args) => { captured = args; }),
    });
    expect(await requestCoachRecommendationsWithDeps(request({ mode: "follow_up", transcript }), valid)).toMatchObject({
      ok: true,
      followUpQuestions: expect.any(Array),
    });
    const serialized = JSON.stringify(captured);
    expect(serialized).toContain("seller_statements_allowed_for_grounding");
    expect(serialized).toContain("conversation_planning_context_only");
    expect(serialized).toContain("Only finalized seller statements may supply a factual premise");
    expect(serialized).toContain("The server writes the final question from the selected template");

    const scriptOnly = deps({
      anthropic: anthropicReturning({
        questions: [
          { template: "tell_more", groundingPhrase: "structure" },
          { template: "impact", groundingPhrase: "audio check" },
          { template: "why_now", groundingPhrase: "once per minute" },
        ],
      }),
    });
    expect(await requestCoachRecommendationsWithDeps(request({ mode: "follow_up", transcript }), scriptOnly)).toMatchObject({
      ok: false,
      code: "provider_error",
    });

    const mixedInventedPremise = deps({
      anthropic: anthropicReturning({
        questions: [
          {
            template: "tell_more",
            groundingPhrase: "audio check",
            question: "Are there structural areas that concern you beyond the audio check?",
          },
          { template: "impact", groundingPhrase: "audio check" },
          { template: "why_now", groundingPhrase: "once per minute" },
        ],
      }),
    });
    expect(await requestCoachRecommendationsWithDeps(request({ mode: "follow_up", transcript }), mixedInventedPremise)).toMatchObject({
      ok: false,
      code: "provider_error",
    });
  });
});
