import { describe, expect, it, vi } from "vitest";

import {
  CALLBACK_AI_MIN_CONFIDENCE,
  NORMA_CALLBACK_TIME_VARIABLE,
  detectStatedTimezone,
  resolveCallbackTime,
  sellerTimezoneForState,
  type CallbackTimeProvider,
} from "./callback-time";

// Friday 2026-10-02 15:30 in Chicago (CDT, UTC-5). 11 days later the zone is still on DST until Nov 1.
const COMPLETED = Date.parse("2026-10-02T20:30:00Z");
const run = (follow: string, extra: { state?: string | null; provider?: CallbackTimeProvider | null; variables?: Record<string, unknown>; now?: number } = {}) =>
  resolveCallbackTime({
    variables: { follow_up_preference: follow, ...extra.variables },
    completedAtMs: COMPLETED,
    nowMs: extra.now ?? COMPLETED,
    state: extra.state === undefined ? "MO" : extra.state,
    provider: extra.provider ?? null,
  });

describe("the constant", () => {
  it("names the optional pathway variable", () => {
    expect(NORMA_CALLBACK_TIME_VARIABLE).toBe("callback_time");
  });
});

describe("seller timezone", () => {
  it("uses the property state, Central when unknown", () => {
    expect(sellerTimezoneForState("OH")).toBe("America/New_York");
    expect(sellerTimezoneForState("ca")).toBe("America/Los_Angeles");
    expect(sellerTimezoneForState("ZZ")).toBe("America/Chicago");
    expect(sellerTimezoneForState(null)).toBe("America/Chicago");
  });
  it("reads timezone words, flags conflicts", () => {
    expect(detectStatedTimezone("after 3 central")).toBe("America/Chicago");
    expect(detectStatedTimezone("3pm est")).toBe("America/New_York");
    expect(detectStatedTimezone("3pm")).toBeUndefined();
    expect(detectStatedTimezone("3pm eastern or pacific")).toBeNull();
  });
});

// [phrase, expected UTC instant or null, extra]
const CASES: [string, string | null, Parameters<typeof run>[1]?][] = [
  // --- documented defaults
  ["Tuesday after 3, Central", "2026-10-06T20:00:00.000Z"],
  ["tomorrow morning", "2026-10-03T14:00:00.000Z"],
  ["tomorrow afternoon", "2026-10-03T19:00:00.000Z"],
  ["tomorrow evening", "2026-10-03T22:00:00.000Z"],
  ["Monday at 10am", "2026-10-05T15:00:00.000Z"],
  ["Monday 9:30 a.m.", "2026-10-05T14:30:00.000Z"],
  ["tomorrow", "2026-10-03T14:00:00.000Z"],
  ["the day after tomorrow at noon", "2026-10-04T17:00:00.000Z"],
  // --- time with no day
  ["after 5", "2026-10-02T22:00:00.000Z"],
  ["after 5 today", "2026-10-02T22:00:00.000Z"],
  ["evening", "2026-10-02T22:00:00.000Z"],
  ["after 3", "2026-10-03T20:00:00.000Z"], // 15:00 already passed today: tomorrow, never the past
  // --- same-weekday and "next"
  ["Friday after 4", "2026-10-02T21:00:00.000Z"],
  ["Friday morning", null], // today 09:00 is past
  ["next Friday", "2026-10-09T14:00:00.000Z"],
  ["next Tuesday", "2026-10-06T14:00:00.000Z"],
  ["next Sunday", null], // could be this Sunday or the one after
  ["Tuesday next week at 2pm", "2026-10-06T19:00:00.000Z"],
  ["next week", "2026-10-05T14:00:00.000Z"],
  ["this week", null],
  // --- timezone words
  ["Tuesday at 3pm Eastern", "2026-10-06T19:00:00.000Z"],
  ["tomorrow at 10am PT", "2026-10-03T17:00:00.000Z"],
  ["Monday 9am MT", "2026-10-05T15:00:00.000Z"],
  ["Tuesday 3pm Eastern or Pacific", null],
  ["Tuesday after 3", "2026-10-06T19:00:00.000Z", { state: "OH" }], // state timezone (Eastern)
  ["Tuesday after 3", "2026-10-06T20:00:00.000Z", { state: null }], // unknown state: Central
  ["Tuesday after 3 Central", "2026-10-06T20:00:00.000Z", { state: "OH" }], // stated zone beats state
  // --- relative amounts and dates
  ["in 2 days", "2026-10-04T14:00:00.000Z"],
  ["in 3 hours", "2026-10-02T23:30:00.000Z"],
  ["in 6 hours", null], // 21:30 local: outside calling hours
  ["10/9 at 2pm", "2026-10-09T19:00:00.000Z"],
  ["October 12th afternoon", "2026-10-12T19:00:00.000Z"],
  ["between 2 and 4 on Monday", "2026-10-05T19:00:00.000Z"],
  ["Monday 10 to 2pm", "2026-10-05T15:00:00.000Z"],
  // --- past and out-of-hours avoidance
  ["today at 2pm", null],
  ["this morning", null],
  ["at 6am tomorrow", null],
  ["after 9pm", null],
  ["midnight", null],
  ["10/1 at 3pm", null], // a date already gone rolls to next year, which is beyond the 60 day horizon
  ["2/30 at 3pm", null],
  // --- ambiguity, hedges, garbage
  ["Tuesday or Thursday", null],
  ["Tuesday at 3 or 5", null],
  ["tomorrow morning but also Thursday", null],
  ["maybe Tuesday after 3", null],
  ["not Tuesday, Wednesday after 3", null],
  ["whenever", null],
  ["anytime this weekend", null],
  ["sometime next month", null],
  ["call me back later", null],
  ["asdf qwerty", null],
  ["", null],
  ["  ", null],
  ["before 5", null],
  ["I'll call you", null],
];

describe("callback time from the seller's words (table)", () => {
  it.each(CASES)("%s", async (phrase, expected, extra) => {
    const result = await run(phrase, extra);
    expect(result?.at ?? null).toBe(expected);
    if (result) expect(result.source).toBe("parsed");
  });

  it("has at least 20 phrasing cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20);
  });

  it("returns the seller's timezone and a confidence", async () => {
    const result = await run("Tuesday after 3, Central");
    expect(result).toMatchObject({ timezone: "America/Chicago", source: "parsed" });
    expect(result!.confidence).toBeGreaterThanOrEqual(0.7);
    expect((await run("after 3"))!.confidence).toBe(0.75);
    expect((await run("next week"))!.confidence).toBe(0.7);
  });

  it("never returns a time at or before the call completion, or before now", async () => {
    for (const [phrase] of CASES) {
      const result = await run(phrase);
      if (result) expect(Date.parse(result.at)).toBeGreaterThan(COMPLETED);
    }
    // Processed hours later: a result earlier than now is dropped, not returned in the past.
    expect(await run("after 5 today", { now: COMPLETED + 3 * 3_600_000 })).toBeNull();
  });

  it("keeps a callback 60 days out at most", async () => {
    expect(await run("12/15 at 3pm")).toBeNull();
    expect((await run("11/20 at 3pm"))?.at).toBe("2026-11-20T21:00:00.000Z");
  });

  it("handles a daylight saving change between now and the callback", async () => {
    // 2026-11-02 15:00 Chicago is CST (UTC-6) after the Nov 1 change.
    expect((await run("11/2 at 3pm"))?.at).toBe("2026-11-02T21:00:00.000Z");
  });
});

describe("exact callback_time", () => {
  const exact = (value: unknown, follow = "garbage words", extra: Parameters<typeof run>[1] = {}) =>
    run(follow, { ...extra, variables: { [NORMA_CALLBACK_TIME_VARIABLE]: value } });

  it("takes precedence over the seller's words", async () => {
    const result = await exact("2026-10-07T10:00:00-05:00", "Tuesday after 3, Central");
    expect(result).toMatchObject({ at: "2026-10-07T15:00:00.000Z", source: "exact", confidence: 1 });
  });
  it("accepts Z and offsets without a colon", async () => {
    expect((await exact("2026-10-07T15:00:00Z"))?.at).toBe("2026-10-07T15:00:00.000Z");
    expect((await exact("2026-10-07T10:00:00-0500"))?.at).toBe("2026-10-07T15:00:00.000Z");
  });
  it("reads an offset-less time in the seller's timezone", async () => {
    expect((await exact("2026-10-07T15:00"))?.at).toBe("2026-10-07T20:00:00.000Z");
    expect((await exact("2026-10-07 15:00:00", "x", { state: "OH" }))?.at).toBe("2026-10-07T19:00:00.000Z");
  });
  it("falls back to the words when the exact value is unusable", async () => {
    for (const bad of ["tomorrow", "2026-13-40T10:00:00Z", "2026-10-01T15:00:00Z", "2027-06-01T15:00:00Z", 42, null, ""]) {
      const result = await exact(bad, "tomorrow morning");
      expect(result?.source, String(bad)).toBe("parsed");
    }
    expect(await exact("nope", "garbage")).toBeNull();
  });
});

describe("AI fallback (provider mocked, no real calls)", () => {
  const ok: CallbackTimeProvider = async () => ({ local_date: "2026-10-12", local_time: "09:00", confidence: 0.9 });

  it("is used only for wording the parser did not recognise", async () => {
    const provider = vi.fn(ok);
    const result = await run("a week from Monday", { provider });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ at: "2026-10-12T14:00:00.000Z", timezone: "America/Chicago", source: "ai" });
    // The provider gets the words, the zone and the reference, nothing else.
    expect(provider.mock.calls[0]![0]).toEqual({
      text: "a week from Monday",
      timezone: "America/Chicago",
      reference: { date: "2026-10-02", time: "15:30", weekday: "Friday" },
    });
  });

  it("is not asked when the parser decided (ok, reject, ambiguous, vague)", async () => {
    const provider = vi.fn(ok);
    for (const phrase of ["tomorrow morning", "Tuesday or Thursday", "whenever", "maybe Tuesday", "today at 2pm", "next Sunday"]) {
      await run(phrase, { provider });
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it("is not asked when there is no exact value to improve on and no words", async () => {
    const provider = vi.fn(ok);
    expect(await run("", { provider })).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });

  it("applies every guard to its answer", async () => {
    const answer = (o: Partial<{ local_date: string | null; local_time: string | null; confidence: number }>): CallbackTimeProvider =>
      async () => ({ local_date: "2026-10-12", local_time: "09:00", confidence: 0.9, ...o });
    const phrase = "second Thursday of next month";
    expect(await run(phrase, { provider: answer({ confidence: CALLBACK_AI_MIN_CONFIDENCE - 0.01 }) })).toBeNull();
    expect(await run(phrase, { provider: answer({ local_date: "2026-10-01" }) })).toBeNull(); // past
    expect(await run(phrase, { provider: answer({ local_date: "2027-03-01" }) })).toBeNull(); // too far
    expect(await run(phrase, { provider: answer({ local_time: "23:00" }) })).toBeNull(); // outside hours
    expect(await run(phrase, { provider: answer({ local_date: null }) })).toBeNull();
    expect(await run(phrase, { provider: answer({ local_date: "not a date" }) })).toBeNull();
    expect(await run(phrase, { provider: async () => null })).toBeNull();
    expect((await run(phrase, { provider: answer({ confidence: 0.99 }) }))?.confidence).toBeLessThanOrEqual(0.95);
  });

  it("returns null when the provider throws or hangs, without waiting forever", async () => {
    expect(await run("a week from Monday", { provider: async () => { throw new Error("boom"); } })).toBeNull();
    const hang: CallbackTimeProvider = () => new Promise(() => {});
    const started = Date.now();
    const result = await resolveCallbackTime({
      variables: { follow_up_preference: "a week from Monday" },
      completedAtMs: COMPLETED, nowMs: COMPLETED, state: "MO", provider: hang, aiTimeoutMs: 30,
    });
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
