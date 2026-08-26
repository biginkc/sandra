import { describe, expect, it } from "vitest";

import { parseCoachEvent } from "./event-validation";

describe("parseCoachEvent — valid events", () => {
  it("parses a transcript event", () => {
    const result = parseCoachEvent({ type: "transcript", speaker: "rep", text: "hey", isFinal: true, ts: "t1" });
    expect(result).toEqual({
      ok: true,
      event: { type: "transcript", speaker: "rep", text: "hey", isFinal: true, ts: "t1" },
    });
  });

  it("parses a phase event with a known phaseId", () => {
    const result = parseCoachEvent({ type: "phase", phaseId: "reveal", ts: "t1" });
    expect(result).toEqual({ ok: true, event: { type: "phase", phaseId: "reveal", ts: "t1" } });
  });

  it("parses objection, counter, gate, and timer events", () => {
    expect(parseCoachEvent({ type: "objection", objectionId: "price_too_low", ts: "t1" })).toEqual({
      ok: true,
      event: { type: "objection", objectionId: "price_too_low", ts: "t1" },
    });
    expect(parseCoachEvent({ type: "counter", probeCount: 4, ts: "t1" })).toEqual({
      ok: true,
      event: { type: "counter", probeCount: 4, ts: "t1" },
    });
    expect(parseCoachEvent({ type: "gate", gateId: "no_concerns", cleared: true, ts: "t1" })).toEqual({
      ok: true,
      event: { type: "gate", gateId: "no_concerns", cleared: true, ts: "t1" },
    });
    expect(parseCoachEvent({ type: "timer", timerId: "hold_timer", startedAt: "t0", durationS: 180, ts: "t1" })).toEqual({
      ok: true,
      event: { type: "timer", timerId: "hold_timer", startedAt: "t0", durationS: 180, ts: "t1" },
    });
  });

  it("parses a coach_note event — first-class, not a forward-compat unknown type", () => {
    const result = parseCoachEvent({
      type: "coach_note",
      text: "Never open with 'How are you doing today?'",
      phaseId: "introduction",
      ts: "t1",
    });
    expect(result).toEqual({
      ok: true,
      event: {
        type: "coach_note",
        text: "Never open with 'How are you doing today?'",
        phaseId: "introduction",
        ts: "t1",
      },
    });
  });

  it("parses a coach_note event with an optional noteId", () => {
    const result = parseCoachEvent({
      type: "coach_note",
      noteId: "note-42",
      text: "Pain word — go deeper.",
      phaseId: "reveal",
      ts: "t1",
    });
    expect(result).toEqual({
      ok: true,
      event: { type: "coach_note", noteId: "note-42", text: "Pain word — go deeper.", phaseId: "reveal", ts: "t1" },
    });
  });

  it("parses a coach_note event with no phaseId at all — not every nudge is phase-scoped", () => {
    const result = parseCoachEvent({ type: "coach_note", text: "Pain word — go deeper.", ts: "t1" });
    expect(result).toEqual({
      ok: true,
      event: { type: "coach_note", text: "Pain word — go deeper.", ts: "t1" },
    });
    if (result.ok) expect("phaseId" in result.event).toBe(false);
  });
});

describe("parseCoachEvent — content versions (scriptVersion/matcherVersion)", () => {
  it("attaches scriptVersion and matcherVersion when present on any event type", () => {
    const result = parseCoachEvent({
      type: "phase",
      phaseId: "reveal",
      ts: "t1",
      scriptVersion: "1.0.1",
      matcherVersion: "3",
    });
    expect(result).toEqual({
      ok: true,
      event: { type: "phase", phaseId: "reveal", ts: "t1", scriptVersion: "1.0.1", matcherVersion: "3" },
    });
  });

  it("omits versions entirely when absent — still valid (producer mid-rollout)", () => {
    const result = parseCoachEvent({ type: "phase", phaseId: "reveal", ts: "t1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("scriptVersion" in result.event).toBe(false);
      expect("matcherVersion" in result.event).toBe(false);
    }
  });

  it("drops a wrong-typed version field rather than passing it through as absent-but-trusted", () => {
    const result = parseCoachEvent({ type: "phase", phaseId: "reveal", ts: "t1", scriptVersion: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) expect("scriptVersion" in result.event).toBe(false);
  });
});

describe("parseCoachEvent — malformed known-type events are dropped and counted", () => {
  it("rejects a phase event with an unrecognized phaseId — this is the exact case that used to wedge the script panel's spinner forever", () => {
    const result = parseCoachEvent({ type: "phase", phaseId: "phase_7_does_not_exist", ts: "t1" });
    expect(result).toEqual({ ok: false, reason: "malformed", rawType: "phase" });
  });

  it("rejects a transcript event with a bad speaker", () => {
    const result = parseCoachEvent({ type: "transcript", speaker: "robot", text: "hi", isFinal: false, ts: "t1" });
    expect(result).toEqual({ ok: false, reason: "malformed", rawType: "transcript" });
  });

  it("rejects a transcript event missing isFinal", () => {
    const result = parseCoachEvent({ type: "transcript", speaker: "rep", text: "hi", ts: "t1" });
    expect(result.ok).toBe(false);
  });

  it("rejects a counter event with a non-finite probeCount", () => {
    expect(parseCoachEvent({ type: "counter", probeCount: "four", ts: "t1" }).ok).toBe(false);
    expect(parseCoachEvent({ type: "counter", probeCount: Number.NaN, ts: "t1" }).ok).toBe(false);
  });

  it("rejects a gate event with a non-boolean cleared", () => {
    expect(parseCoachEvent({ type: "gate", gateId: "no_concerns", cleared: "yes", ts: "t1" }).ok).toBe(false);
  });

  it("rejects a timer event missing durationS", () => {
    expect(parseCoachEvent({ type: "timer", timerId: "hold_timer", startedAt: "t0", ts: "t1" }).ok).toBe(false);
  });

  it("rejects a coach_note event missing text", () => {
    expect(parseCoachEvent({ type: "coach_note", phaseId: "introduction", ts: "t1" }).ok).toBe(false);
  });

  it("rejects a coach_note event with an unrecognized phaseId", () => {
    const result = parseCoachEvent({ type: "coach_note", text: "hi", phaseId: "not_a_real_phase", ts: "t1" });
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
    const result = parseCoachEvent({ type: "deal_update", offerPrice: "$210,000", ts: "t1" });
    expect(result).toEqual({ ok: false, reason: "unknown_type", rawType: "deal_update" });
  });
});
