import { describe, expect, it } from "vitest";

import { parseCoachEvent } from "./event-validation";

/** Every wire message carries both content versions, always — required per
 * the producer's verbatim wire contract. Spread into every payload/expected
 * event below rather than repeating the two fields in each test. */
const V = { scriptVersion: "1.0.1", matcherVersion: "3" };

describe("parseCoachEvent — valid events", () => {
  it("parses a transcript event", () => {
    const result = parseCoachEvent({ type: "transcript", speaker: "rep", text: "hey", isFinal: true, ts: "t1", ...V });
    expect(result).toEqual({
      ok: true,
      event: { type: "transcript", speaker: "rep", text: "hey", isFinal: true, ts: "t1", ...V },
    });
  });

  it("parses a phase event with a known phaseId", () => {
    const result = parseCoachEvent({ type: "phase", phaseId: "reveal", ts: "t1", ...V });
    expect(result).toEqual({ ok: true, event: { type: "phase", phaseId: "reveal", ts: "t1", ...V } });
  });

  it("parses objection, counter, gate, and timer events", () => {
    expect(parseCoachEvent({ type: "objection", objectionId: "price_too_low", ts: "t1", ...V })).toEqual({
      ok: true,
      event: { type: "objection", objectionId: "price_too_low", ts: "t1", ...V },
    });
    expect(parseCoachEvent({ type: "counter", probeCount: 4, ts: "t1", ...V })).toEqual({
      ok: true,
      event: { type: "counter", probeCount: 4, ts: "t1", ...V },
    });
    expect(parseCoachEvent({ type: "gate", gateId: "no_concerns", cleared: true, ts: "t1", ...V })).toEqual({
      ok: true,
      event: { type: "gate", gateId: "no_concerns", cleared: true, ts: "t1", ...V },
    });
    expect(
      parseCoachEvent({ type: "timer", timerId: "hold_timer", startedAt: "2026-08-26T18:00:00.000Z", durationS: 180, ts: "t1", ...V }),
    ).toEqual({
      ok: true,
      event: { type: "timer", timerId: "hold_timer", startedAt: "2026-08-26T18:00:00.000Z", durationS: 180, ts: "t1", ...V },
    });
  });

  it("parses a coach_note event — first-class, not a forward-compat unknown type", () => {
    const result = parseCoachEvent({
      type: "coach_note",
      text: "Never open with 'How are you doing today?'",
      phaseId: "introduction",
      ts: "t1",
      ...V,
    });
    expect(result).toEqual({
      ok: true,
      event: {
        type: "coach_note",
        text: "Never open with 'How are you doing today?'",
        phaseId: "introduction",
        ts: "t1",
        ...V,
      },
    });
  });
});

describe("parseCoachEvent — content versions (scriptVersion/matcherVersion)", () => {
  it("attaches scriptVersion and matcherVersion — required on every event type", () => {
    const result = parseCoachEvent({ type: "phase", phaseId: "reveal", ts: "t1", ...V });
    expect(result).toEqual({
      ok: true,
      event: { type: "phase", phaseId: "reveal", ts: "t1", ...V },
    });
  });

  it("rejects an event missing scriptVersion — per the wire contract, not optional", () => {
    const result = parseCoachEvent({ type: "phase", phaseId: "reveal", ts: "t1", matcherVersion: V.matcherVersion });
    expect(result).toEqual({ ok: false, reason: "malformed", rawType: "phase" });
  });

  it("rejects an event missing matcherVersion", () => {
    const result = parseCoachEvent({ type: "phase", phaseId: "reveal", ts: "t1", scriptVersion: V.scriptVersion });
    expect(result).toEqual({ ok: false, reason: "malformed", rawType: "phase" });
  });

  it("rejects a wrong-typed version field rather than passing it through as absent-but-trusted", () => {
    const result = parseCoachEvent({
      type: "phase",
      phaseId: "reveal",
      ts: "t1",
      scriptVersion: 42,
      matcherVersion: V.matcherVersion,
    });
    expect(result).toEqual({ ok: false, reason: "malformed", rawType: "phase" });
  });
});

describe("parseCoachEvent — malformed known-type events are dropped and counted", () => {
  it("rejects a phase event with an unrecognized phaseId — this is the exact case that used to wedge the script panel's spinner forever", () => {
    const result = parseCoachEvent({ type: "phase", phaseId: "phase_7_does_not_exist", ts: "t1", ...V });
    expect(result).toEqual({ ok: false, reason: "malformed", rawType: "phase" });
  });

  it("rejects a transcript event with a bad speaker", () => {
    const result = parseCoachEvent({ type: "transcript", speaker: "robot", text: "hi", isFinal: false, ts: "t1", ...V });
    expect(result).toEqual({ ok: false, reason: "malformed", rawType: "transcript" });
  });

  it("rejects a transcript event missing isFinal", () => {
    const result = parseCoachEvent({ type: "transcript", speaker: "rep", text: "hi", ts: "t1", ...V });
    expect(result.ok).toBe(false);
  });

  it("rejects a counter event with a non-finite probeCount", () => {
    expect(parseCoachEvent({ type: "counter", probeCount: "four", ts: "t1", ...V }).ok).toBe(false);
    expect(parseCoachEvent({ type: "counter", probeCount: Number.NaN, ts: "t1", ...V }).ok).toBe(false);
  });

  it("rejects negative and fractional counter values before they can corrupt the live UI", () => {
    expect(parseCoachEvent({ type: "counter", probeCount: -1, ts: "t1", ...V }).ok).toBe(false);
    expect(parseCoachEvent({ type: "counter", probeCount: 1.5, ts: "t1", ...V }).ok).toBe(false);
  });

  it("rejects a gate event with a non-boolean cleared", () => {
    expect(parseCoachEvent({ type: "gate", gateId: "no_concerns", cleared: "yes", ts: "t1", ...V }).ok).toBe(false);
  });

  it("rejects a timer event missing durationS", () => {
    expect(parseCoachEvent({ type: "timer", timerId: "hold_timer", startedAt: "2026-08-26T18:00:00.000Z", ts: "t1", ...V }).ok).toBe(false);
  });

  it("rejects invalid timer ranges and unparseable starts instead of rendering Hold NaN:NaN", () => {
    expect(parseCoachEvent({ type: "timer", timerId: "hold_timer", startedAt: "2026-08-26T18:00:00.000Z", durationS: -1, ts: "t1", ...V }).ok).toBe(false);
    expect(parseCoachEvent({ type: "timer", timerId: "hold_timer", startedAt: "2026-08-26T18:00:00.000Z", durationS: 1.5, ts: "t1", ...V }).ok).toBe(false);
    expect(parseCoachEvent({ type: "timer", timerId: "hold_timer", startedAt: "not-a-date", durationS: 180, ts: "t1", ...V }).ok).toBe(false);
  });

  it("rejects a coach_note event missing text", () => {
    expect(parseCoachEvent({ type: "coach_note", phaseId: "introduction", ts: "t1", ...V }).ok).toBe(false);
  });

  it("rejects a coach_note event missing phaseId — required, not optional, per the wire contract", () => {
    const result = parseCoachEvent({ type: "coach_note", text: "hi", ts: "t1", ...V });
    expect(result).toEqual({ ok: false, reason: "malformed", rawType: "coach_note" });
  });

  it("rejects a coach_note event with an unrecognized phaseId", () => {
    const result = parseCoachEvent({ type: "coach_note", text: "hi", phaseId: "not_a_real_phase", ts: "t1", ...V });
    expect(result).toEqual({ ok: false, reason: "malformed", rawType: "coach_note" });
  });

  it("rejects a non-object payload", () => {
    expect(parseCoachEvent(null).ok).toBe(false);
    expect(parseCoachEvent("just a string").ok).toBe(false);
    expect(parseCoachEvent(42).ok).toBe(false);
  });

  it("rejects a payload with no type field", () => {
    expect(parseCoachEvent({ speaker: "rep" }).ok).toBe(false);
  });
});

describe("parseCoachEvent — unknown event types are tolerated, not counted as malformed", () => {
  it("treats a genuinely unrecognized type as unknown_type, not malformed", () => {
    const result = parseCoachEvent({ type: "deal_update", offerPrice: "$210,000", ts: "t1", ...V });
    expect(result).toEqual({ ok: false, reason: "unknown_type", rawType: "deal_update" });
  });
});
