import { describe, expect, it, vi } from "vitest";

import type { CoachRecommendationRequest } from "./recommendation-types";
import {
  FOLLOW_UP_RECOMMENDATION_LIMIT_PER_CALL,
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
    selectedSectionBranch: null,
    branchOverrides: {},
    mode: "follow_up",
    transcript: [{ speaker: "seller", text: "I need to sell because the repairs are too expensive.", isFinal: true }],
    ...overrides,
  };
}

const DEFAULT_FOLLOW_UP_QUESTIONS = [
  { template: "tell_more", groundingPhrase: "repairs are too expensive" },
  { template: "impact", groundingPhrase: "repairs" },
  { template: "priority", groundingPhrase: "repairs" },
] as const;

function anthropicReturning(input: unknown, capture?: (args: unknown) => void): CoachRecommendationAnthropic {
  return {
    messages: {
      create: vi.fn(async (args: unknown) => {
        capture?.(args);
        return {
          content: [{ type: "tool_use", id: "tool-1", name: "submit_follow_up_questions", input }],
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
    anthropic: anthropicReturning({ questions: DEFAULT_FOLLOW_UP_QUESTIONS }),
    limiter: { consume: vi.fn(async () => ({ allowed: true })) },
    ...overrides,
  };
}

describe("coach recommendation server boundary", () => {
  it("authenticates, verifies call ownership, and consumes the mode-specific server limit", async () => {
    const dependencies = deps();
    const result = await requestCoachRecommendationsWithDeps(request(), dependencies);

    expect(result).toMatchObject({ ok: true, mode: "follow_up", followUpQuestions: expect.any(Array) });
    expect(dependencies.calls.findOwnedCall).toHaveBeenCalledWith({ callId: "call-1", userId: "user-1" });
    expect(dependencies.contexts.load).toHaveBeenCalledWith({ propertyId: "property-1" });
    expect(dependencies.limiter.consume).toHaveBeenCalledWith({
      userId: "user-1",
      callId: "call-1",
      mode: "follow_up",
      limit: FOLLOW_UP_RECOMMENDATION_LIMIT_PER_CALL,
    });
  });

  it("rejects a request with mode \"automatic\" as invalid — the click-driven path accepts only follow_up", async () => {
    const anthropic = anthropicReturning({ questions: DEFAULT_FOLLOW_UP_QUESTIONS });
    // requestCoachRecommendationsWithDeps takes unknown input precisely so it
    // can validate a payload from an untyped caller (a stale client bundle,
    // a hand-crafted request) — "automatic" is no longer a value the type
    // system can even express, so this deliberately bypasses it.
    const result = await requestCoachRecommendationsWithDeps(
      { ...request(), mode: "automatic" },
      deps({ anthropic }),
    );

    expect(result).toMatchObject({ ok: false, code: "invalid_request" });
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated and unowned calls before provider use", async () => {
    const anthropic = anthropicReturning({ questions: DEFAULT_FOLLOW_UP_QUESTIONS });
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
    const anthropic = anthropicReturning({ questions: DEFAULT_FOLLOW_UP_QUESTIONS });
    const dependencies = deps({ limiter: { consume: vi.fn(async () => ({ allowed: false })) }, anthropic });
    const result = await requestCoachRecommendationsWithDeps(request(), dependencies);

    expect(result).toMatchObject({ ok: false, code: "rate_limited" });
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it("the supplied limiter enforces the exact per-key limit", async () => {
    const limiter = createInMemoryCoachRecommendationLimiter();
    const input = { userId: "u", callId: "c", mode: "follow_up" as const, limit: 2 };
    await expect(limiter.consume(input)).resolves.toEqual({ allowed: true });
    await expect(limiter.consume(input)).resolves.toEqual({ allowed: true });
    await expect(limiter.consume(input)).resolves.toEqual({ allowed: false });
    await expect(limiter.consume({ ...input, callId: "other" })).resolves.toEqual({ allowed: true });
  });

  it("rejects interim-only transcript input and a transcript missing a seller line", async () => {
    const interim = request({ transcript: [{ speaker: "seller", text: "The roof is leaking badly", isFinal: false }] });
    expect(await requestCoachRecommendationsWithDeps(interim, deps())).toMatchObject({ ok: false, code: "invalid_request" });

    const repOnlyFollowUp = request({
      transcript: [{ speaker: "rep", text: "Tell me more about what has you considering a move.", isFinal: true }],
    });
    expect(await requestCoachRecommendationsWithDeps(repOnlyFollowUp, deps())).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
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

  it("isolates every selected Offer and Close path and defaults invalid path tags to the first authored branch", () => {
    const cases = [
      ["offer.outcome-tracks", "Good news", "CONGRATS", ["right around where I was thinking", "not able to get you approved", "our offer was lower"]],
      ["offer.outcome-tracks", "Bad news", "right around where I was thinking", ["CONGRATS", "not able to get you approved", "our offer was lower"]],
      ["offer.outcome-tracks", "Bad news — below mortgage", "not able to get you approved", ["CONGRATS", "right around where I was thinking", "our offer was lower"]],
      ["offer.outcome-tracks", "Price too low", "our offer was lower", ["CONGRATS", "right around where I was thinking", "not able to get you approved"]],
      ["close.decision-tracks", "If far apart — program pivot", "There is one program I can check", ["Congratulations"]],
      ["close.decision-tracks", "They accept", "Congratulations", ["There is one program I can check"]],
    ] as const;

    for (const [sectionId, selectedPath, included, excluded] of cases) {
      const script = loadTrustedSectionContext(sectionId, {}, selectedPath)?.scriptLines.join("\n") ?? "";
      expect(script).toContain(included);
      for (const siblingText of excluded) expect(script).not.toContain(siblingText);
    }

    expect(loadTrustedSectionContext("offer.outcome-tracks", {}, "not-authored")).toEqual(
      loadTrustedSectionContext("offer.outcome-tracks", {}, "Good news"),
    );
    expect(loadTrustedSectionContext("close.decision-tracks", {}, null)).toEqual(
      loadTrustedSectionContext("close.decision-tracks", {}, "If far apart — program pivot"),
    );
  });

  it("uses the validated selected path in the provider prompt", async () => {
    let captured: unknown;
    const dependencies = deps({
      anthropic: anthropicReturning(
        { questions: DEFAULT_FOLLOW_UP_QUESTIONS },
        (args) => { captured = args; },
      ),
    });

    const result = await requestCoachRecommendationsWithDeps(
      request({
        activeSectionId: "offer.outcome-tracks",
        selectedSectionBranch: "Price too low",
        branchOverrides: { "Price too low": "default" },
      }),
      dependencies,
    );

    expect(result).toMatchObject({ ok: true });
    const serialized = JSON.stringify(captured);
    expect(serialized).toContain("our offer was lower");
    expect(serialized).not.toContain("CONGRATS");
    expect(serialized).not.toContain("right around where I was thinking");
    expect(serialized).not.toContain("not able to get you approved");
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
        { questions: [
          { template: "tell_more", groundingPhrase: "roof issue is urgent" },
          { template: "impact", groundingPhrase: "roof issue" },
          { template: "priority", groundingPhrase: "urgent" },
        ] },
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

  it("redacts phone numbers across separator styles, including slash and en dash", () => {
    // Substring containment isn't enough here: the original regex only ever
    // matched starting at a digit, so "(816) 555-1212" redacted to
    // "([phone removed]" — a stray leading paren survived while still
    // "containing" [phone removed]. Assert the exact output.
    expect(redactPhoneNumbers("Call me at 816/555/1212 today.")).toBe("Call me at [phone removed] today.");
    expect(redactPhoneNumbers("Call me at 816–555–1212 today.")).toBe("Call me at [phone removed] today.");
    expect(redactPhoneNumbers("Call me at (816) 555-1212 today.")).toBe("Call me at [phone removed] today.");
    expect(redactPhoneNumbers("Call me at 816.555.1212 today.")).toBe("Call me at [phone removed] today.");
    expect(redactPhoneNumbers("Call me at +1 816 555 1212 today.")).toBe("Call me at [phone removed] today.");
    expect(redactPhoneNumbers("Built in 1987 at 1234 Main St")).toBe("Built in 1987 at 1234 Main St");
  });

  it("redacts phone numbers written with Unicode dash variants and fullwidth digits", () => {
    // Each string below reads as an ordinary phone number to a person but
    // uses a separator or digit form the plain ASCII regex alone never
    // matched — the trailing comment on each pins the exact codepoint.
    const nonBreakingHyphen = "Call me at 816‑555‑1212 today."; // U+2011
    const figureDash = "Call me at 816‒555‒1212 today."; // U+2012
    const unicodeMinus = "Call me at 816−555−1212 today."; // U+2212
    const middleDot = "Call me at 816·555·1212 today."; // U+00B7
    const fullwidthDigits = "Call me at ８１６５５５１２１２ today."; // "8165551212"

    for (const input of [nonBreakingHyphen, figureDash, unicodeMinus, middleDot, fullwidthDigits]) {
      expect(redactPhoneNumbers(input)).toBe("Call me at [phone removed] today.");
    }

    // Katakana middle dot and hyphenation point as inter-digit separators,
    // and non-breaking space (\u00A0) in place of a plain space.
    expect(redactPhoneNumbers("Call 816・555・1212 now.")).toBe("Call [phone removed] now.");
    expect(redactPhoneNumbers("Call 816‧555‧1212 now.")).toBe("Call [phone removed] now.");
    expect(redactPhoneNumbers("Call\u00A0816\u00A0555\u00A01212\u00A0now.")).toBe("Call [phone removed] now.");
  });

  it("redacts a phone number split by zero-width characters before it reaches the prompt", async () => {
    let captured: unknown;
    const dependencies = deps({
      anthropic: anthropicReturning(
        { questions: [
          { template: "tell_more", groundingPhrase: "roof issue is urgent" },
          { template: "impact", groundingPhrase: "roof issue" },
          { template: "priority", groundingPhrase: "urgent" },
        ] },
        (args) => { captured = args; },
      ),
    });
    // Every other digit is followed by a zero-width space (U+200B) -- reads
    // as an ordinary 10-digit number to a person, but a naive digit-run
    // regex over the raw text sees only single isolated digits.
    const zeroWidthPhone = "8\u200b1\u200b6\u200b5\u200b5\u200b5\u200b1\u200b2\u200b1\u200b2";
    const result = await requestCoachRecommendationsWithDeps(
      request({ transcript: [{ speaker: "seller", text: `Call me at ${zeroWidthPhone} because the roof issue is urgent.`, isFinal: true }] }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(zeroWidthPhone);
    expect(serialized).not.toContain("8165551212");
    expect(serialized).toContain("[phone removed]");
  });

  it("redacts a phone number interleaved with a bidi control mark before it reaches the prompt", async () => {
    let captured: unknown;
    const dependencies = deps({
      anthropic: anthropicReturning(
        { questions: [
          { template: "tell_more", groundingPhrase: "roof issue is urgent" },
          { template: "impact", groundingPhrase: "roof issue" },
          { template: "priority", groundingPhrase: "urgent" },
        ] },
        (args) => { captured = args; },
      ),
    });
    // Right-to-Left Mark (U+200F) interleaved between every digit -- a
    // zero-width bidi control, invisible like the zero-width space above,
    // but from the bidi-control family rather than the zero-width-joiner
    // family. Wrapping the whole number in an override (U+202E/U+202C)
    // alone would NOT evade the old digit-adjacency regex, since the
    // digits themselves stay contiguous; interleaving is what breaks it.
    const bidiPhone = "8\u200f1\u200f6\u200f5\u200f5\u200f5\u200f1\u200f2\u200f1\u200f2";
    const result = await requestCoachRecommendationsWithDeps(
      request({ transcript: [{ speaker: "seller", text: `Call me at ${bidiPhone} because the roof issue is urgent.`, isFinal: true }] }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(bidiPhone);
    expect(serialized).not.toContain("8165551212");
    expect(serialized).toContain("[phone removed]");
  });

  it("redacts a phone number written in Arabic-Indic digits before it reaches the prompt", async () => {
    let captured: unknown;
    const dependencies = deps({
      anthropic: anthropicReturning(
        { questions: [
          { template: "tell_more", groundingPhrase: "roof issue is urgent" },
          { template: "impact", groundingPhrase: "roof issue" },
          { template: "priority", groundingPhrase: "urgent" },
        ] },
        (args) => { captured = args; },
      ),
    });
    // U+0660-U+0669: Arabic-Indic digits 0-9, spelling out "8165551212".
    const arabicIndicPhone = "٨١٦٥٥٥١٢١٢";
    const result = await requestCoachRecommendationsWithDeps(
      request({ transcript: [{ speaker: "seller", text: `Call me at ${arabicIndicPhone} because the roof issue is urgent.`, isFinal: true }] }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(arabicIndicPhone);
    expect(serialized).not.toContain("8165551212");
    expect(serialized).toContain("[phone removed]");
  });

  it("redacts a phone number written in Devanagari digits before it reaches the prompt", async () => {
    let captured: unknown;
    const dependencies = deps({
      anthropic: anthropicReturning(
        { questions: [
          { template: "tell_more", groundingPhrase: "roof issue is urgent" },
          { template: "impact", groundingPhrase: "roof issue" },
          { template: "priority", groundingPhrase: "urgent" },
        ] },
        (args) => { captured = args; },
      ),
    });
    // U+0966-U+096F: Devanagari digits 0-9, spelling out "8165551212".
    const devanagariPhone = "८१६५५५१२१२";
    const result = await requestCoachRecommendationsWithDeps(
      request({ transcript: [{ speaker: "seller", text: `Call me at ${devanagariPhone} because the roof issue is urgent.`, isFinal: true }] }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(devanagariPhone);
    expect(serialized).not.toContain("8165551212");
    expect(serialized).toContain("[phone removed]");
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
    expect(result).toMatchObject({ ok: true, followUpQuestions: expect.arrayContaining([expect.any(String)]) });
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

  it("rejects three questions whose grounding phrases differ only by punctuation as not distinct", async () => {
    // The grounding matcher already ignores punctuation when it accepts a
    // phrase (containsWholeGroundingPhrase / normalizeGroundingText), so
    // "roof repairs", "roof-repairs" and "roof, repairs" read as the same
    // grounded content and must not be able to pass as three distinct
    // questions just because the model varied the punctuation.
    const punctuationOnly = deps({
      anthropic: anthropicReturning({
        questions: [
          { template: "tell_more", groundingPhrase: "roof repairs" },
          { template: "tell_more", groundingPhrase: "roof-repairs" },
          { template: "tell_more", groundingPhrase: "roof, repairs" },
        ],
      }),
    });
    const result = await requestCoachRecommendationsWithDeps(
      request({ transcript: [{ speaker: "seller", text: "The roof repairs are expensive.", isFinal: true }] }),
      punctuationOnly,
    );
    expect(result).toMatchObject({ ok: false, code: "provider_error" });
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
