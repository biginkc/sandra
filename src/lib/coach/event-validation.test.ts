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
  it("treats a forward-compat type like coach_note as unknown_type, not malformed", () => {
    const result = parseCoachEvent({ type: "coach_note", text: "Never open with...", phaseId: "introduction", ts: "t1" });
    expect(result).toEqual({ ok: false, reason: "unknown_type", rawType: "coach_note" });
  });
});
