import { describe, expect, it } from "vitest";

import { mapBlandCallToOutcome, parseCallbackTime } from "./outcome";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const human = (variables: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  completed: true, status: "completed", answered_by: "human", variables, summary: "s", ...extra,
});
const map = (call: Record<string, unknown>) => mapBlandCallToOutcome(call, NOW);

describe("outcome mapping", () => {
  it.each([
    ["no-answer status", { completed: true, status: "no-answer", answered_by: null, variables: {} }, "no_answer"],
    ["no-answer answered_by", { completed: true, status: "completed", answered_by: "no-answer", variables: {} }, "no_answer"],
    ["voicemail hung up on", { completed: true, status: "completed", answered_by: "voicemail", variables: {} }, "no_answer"],
    ["callback", human({ call_outcome: "callback_requested" }), "callback_requested"],
    ["reached no follow-up", human({ call_outcome: "reached", follow_up_preference: "none" }), "reached_no_callback"],
    ["reached + follow-up", human({ call_outcome: "Reached", follow_up_preference: "tomorrow afternoon" }), "callback_requested"],
    ["not interested", human({ call_outcome: "not_interested" }), "not_interested"],
    ["stop calling -> not_interested", human({ call_outcome: "stop calling" }), "not_interested"],
    ["wrong number", human({ call_outcome: "wrong_number" }), "wrong_number"],
  ])("%s", (_name, call, expected) => {
    expect(map(call).outcome).toBe(expected);
  });

  it.each([
    ["not completed", { ...human({ call_outcome: "reached" }), completed: false }],
    ["busy", { completed: true, status: "busy", variables: {} }],
    ["failed", { completed: true, status: "failed", variables: {} }],
    ["human but no call_outcome", human({})],
    ["human, unrecognised outcome", human({ call_outcome: "banana" })],
    ["answered_by unknown", { ...human({ call_outcome: "reached" }), answered_by: "unknown" }],
    ["no-answer contradicts outcome", { completed: true, status: "no-answer", variables: { call_outcome: "callback_requested" } }],
    ["human but outcome says no_answer", human({ call_outcome: "no_answer" })],
    ["stop + follow-up conflict", human({ call_outcome: "not_interested", follow_up_preference: "call me monday" })],
    ["empty payload", {}],
  ])("unknown: %s", (_name, call) => {
    const mapped = map(call);
    expect(mapped.outcome).toBe("unknown");
    expect(mapped.reason).toBeTruthy();
  });

  it("callback payload carries raw text, validated time and timezone", () => {
    const mapped = map(human({
      call_outcome: "callback_requested", follow_up_preference: "after 5", callback_time_iso: "2026-10-03T15:00:00-05:00",
      callback_timezone: "America/Chicago",
    }));
    expect(mapped.payload).toMatchObject({
      callback_requested_for: "2026-10-03T20:00:00.000Z", callback_timezone: "America/Chicago", callback_raw: "after 5", summary: "s",
    });
  });

  it("an unparseable or past callback time is dropped, not guessed", () => {
    expect(parseCallbackTime("tomorrow", NOW)).toBeNull();
    expect(parseCallbackTime("2026-10-03T15:00:00", NOW)).toBeNull(); // no offset
    expect(parseCallbackTime("2026-10-01T15:00:00Z", NOW)).toBeNull(); // past
    expect(parseCallbackTime("2027-10-01T15:00:00Z", NOW)).toBeNull(); // too far
    expect(map(human({ call_outcome: "callback", callback_time_iso: "soon" })).payload.callback_requested_for).toBeNull();
  });

  it("qualification keeps only capped scalars", () => {
    const mapped = map(human({ call_outcome: "reached", a: "x".repeat(900), b: 3, c: true, d: { nested: 1 }, e: [1] }));
    const q = mapped.payload.qualification as Record<string, unknown>;
    expect((q.a as string).length).toBe(500);
    expect(q).toMatchObject({ b: 3, c: true });
    expect("d" in q || "e" in q).toBe(false);
  });
});
