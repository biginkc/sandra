import { describe, expect, it } from "vitest";

import {
  BLAND_EXTRACTION_VARIABLES,
  CALL_OUTCOME_TOKEN_MAP,
  composeSummary,
  mapBlandCallToOutcome,
  parseCallbackTime,
  parseCallOutcomeToken,
} from "./outcome";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const human = (variables: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  completed: true, status: "completed", answered_by: "human", variables, summary: "s", ...extra,
});
const map = (call: Record<string, unknown>) => mapBlandCallToOutcome(call, NOW);

describe("call_outcome token", () => {
  it("takes the leading token, case-insensitive, punctuation stripped", () => {
    expect(parseCallOutcomeToken("callback_requested - seller asked for after 5")).toBe("callback_requested");
    expect(parseCallOutcomeToken("  Not_Interested: said stop")).toBe("not_interested");
    expect(parseCallOutcomeToken('"WRONG_PERSON."')).toBe("wrong_person");
    expect(parseCallOutcomeToken("")).toBe("");
    expect(parseCallOutcomeToken(42)).toBe("");
  });
});

describe("inherited object keys are not outcomes", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("%s maps to unknown", (token) => {
    const mapped = map(human({ call_outcome: token }));
    expect(mapped.outcome).toBe("unknown");
    expect(mapped.reason).toBe("unrecognised_call_outcome");
  });
});

describe("outcome mapping table (live pathway v3)", () => {
  it.each([
    ["do_not_contact", "not_interested"],
    ["not_interested", "not_interested"],
    ["wrong_person", "wrong_number"],
    ["callback_requested", "callback_requested"],
    ["qualified_review_requested", "reached_no_callback"],
    ["interested_incomplete", "reached_no_callback"],
    ["human_requested", "reached_no_callback"],
  ])("human answered, %s -> %s", (token, expected) => {
    expect(map(human({ call_outcome: `${token}. seller said so` })).outcome).toBe(expected);
  });

  it("voicemail token with a voicemail-answered call -> no_answer", () => {
    expect(map({ completed: true, status: "completed", answered_by: "voicemail", variables: { call_outcome: "voicemail" } }).outcome).toBe("no_answer");
  });

  it.each([
    ["no-answer status", { completed: true, status: "no-answer", answered_by: null, variables: {} }],
    ["no-answer answered_by", { completed: true, status: "completed", answered_by: "no-answer", variables: {} }],
    ["busy status", { completed: true, status: "busy", variables: {} }],
  ])("Bland-confirmed %s -> no_answer even without a pathway outcome", (_n, call) => {
    expect(map(call).outcome).toBe("no_answer");
  });

  it("the table is exactly the contract, no guessed values", () => {
    expect(CALL_OUTCOME_TOKEN_MAP).toEqual({
      do_not_contact: "not_interested", not_interested: "not_interested", wrong_person: "wrong_number",
      voicemail: "no_answer", callback_requested: "callback_requested",
      qualified_review_requested: "reached_no_callback", interested_incomplete: "reached_no_callback",
      human_requested: "reached_no_callback", already_sold: "unknown", unclear: "unknown",
    });
    for (const guessed of ["declined", "stop", "qualified", "interested", "completed", "wrong_number", "reached"]) {
      expect(map(human({ call_outcome: guessed })).outcome).toBe("unknown");
    }
  });

  it.each([
    ["already_sold", human({ call_outcome: "already_sold" })],
    ["unclear", human({ call_outcome: "unclear" })],
    ["unrecognised token", human({ call_outcome: "banana split" })],
    ["missing outcome", human({})],
    ["not completed", { ...human({ call_outcome: "callback_requested" }), completed: false }],
    ["failed", { completed: true, status: "failed", variables: {} }],
    ["answered_by unknown", { ...human({ call_outcome: "human_requested" }), answered_by: "unknown" }],
    ["no-answer contradicts outcome", { completed: true, status: "no-answer", variables: { call_outcome: "callback_requested" } }],
    ["human answered but outcome voicemail", human({ call_outcome: "voicemail" })],
    ["empty payload", {}],
  ])("unknown: %s", (_name, call) => {
    const mapped = map(call);
    expect(mapped.outcome).toBe("unknown");
    expect(mapped.reason).toBeTruthy();
  });

  it("callback: raw text kept, no ISO time, timezone left in the raw text", () => {
    const mapped = map(human({ call_outcome: "callback_requested - asked", follow_up_preference: "Tomorrow after 5pm Central" }));
    expect(mapped.payload).toMatchObject({
      callback_requested_for: null, callback_timezone: null, callback_raw: "Tomorrow after 5pm Central",
    });
  });

  it("callback with no follow-up text stores no raw text", () => {
    expect(map(human({ call_outcome: "callback_requested" })).payload.callback_raw).toBeNull();
  });

  it("only callbacks carry callback fields; reached outcomes keep follow_up_preference in qualification only", () => {
    const mapped = map(human({ call_outcome: "human_requested", follow_up_preference: "call me monday" }));
    expect(mapped.payload.callback_raw).toBeUndefined();
    expect((mapped.payload.qualification as Record<string, string>).follow_up_preference).toBe("call me monday");
  });

  it("parseCallbackTime stays strict if the due-now constant is ever flipped", () => {
    expect(parseCallbackTime("tomorrow", NOW)).toBeNull();
    expect(parseCallbackTime("2026-10-03T15:00:00", NOW)).toBeNull();
    expect(parseCallbackTime("2026-10-01T15:00:00Z", NOW)).toBeNull();
    expect(parseCallbackTime("2026-10-03T15:00:00-05:00", NOW)).toBe("2026-10-03T20:00:00.000Z");
  });
});

describe("qualification and summary", () => {
  const all = Object.fromEntries(BLAND_EXTRACTION_VARIABLES.map((k) => [k, `${k} value`]));

  it("stores every extraction variable in qualification", () => {
    const q = map(human({ ...all, call_outcome: "human_requested ok" })).payload.qualification as Record<string, unknown>;
    for (const key of BLAND_EXTRACTION_VARIABLES) expect(q).toHaveProperty(key);
  });

  it("summary = Bland summary + the four displayed answers", () => {
    const summary = composeSummary("Bland says hi", all)!;
    expect(summary.split("\n")).toEqual([
      "Bland says hi",
      "Motivation and timing: motivation_and_timeline value",
      "Condition: condition_and_financing value",
      "Asking price and flexibility: price_expectation value",
      "Decision-makers: ownership_and_occupancy value",
    ]);
    expect(composeSummary(null, {})).toBeNull();
  });

  it("long values are capped and non-scalars dropped", () => {
    const q = map(human({ call_outcome: "human_requested", a: "x".repeat(5000), n: { nested: 1 } })).payload.qualification as Record<string, unknown>;
    expect((q.a as string).length).toBe(2000);
    expect("n" in q).toBe(false);
  });
});
