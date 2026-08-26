import { describe, expect, it } from "vitest";

import { coachReducer, initialCoachState } from "./event-reducer";
import type { CoachState } from "./types";

describe("coachReducer — transcript", () => {
  it("appends a final line for a fresh speaker turn", () => {
    const state = coachReducer(initialCoachState(), {
      type: "transcript",
      speaker: "rep",
      text: "Hey Jane, this is Alex.",
      isFinal: true,
      ts: "2026-08-26T10:00:00Z",
    });
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({ speaker: "rep", text: "Hey Jane, this is Alex.", isFinal: true });
    expect(state.connected).toBe(true);
  });

  it("updates the trailing interim line in place instead of stacking duplicates", () => {
    let state = initialCoachState();
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "yeah I", isFinal: false, ts: "t1" });
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "yeah I guess", isFinal: false, ts: "t2" });
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0].text).toBe("yeah I guess");
    expect(state.transcript[0].isFinal).toBe(false);

    state = coachReducer(state, {
      type: "transcript",
      speaker: "seller",
      text: "yeah I guess so",
      isFinal: true,
      ts: "t3",
    });
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({ text: "yeah I guess so", isFinal: true });
  });

  it("starts a new line once a final has landed, even for the same speaker", () => {
    let state = initialCoachState();
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "first", isFinal: true, ts: "t1" });
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "second", isFinal: true, ts: "t2" });
    expect(state.transcript).toHaveLength(2);
  });

  it("does not interleave a new speaker's interim line into the previous speaker's turn", () => {
    let state = initialCoachState();
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "hello", isFinal: false, ts: "t1" });
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "hi", isFinal: false, ts: "t2" });
    expect(state.transcript).toHaveLength(2);
    expect(state.transcript.map((line) => line.speaker)).toEqual(["rep", "seller"]);
  });
});

describe("coachReducer — phase advance", () => {
  it("moves the current phase and clears any manual override", () => {
    let state: CoachState = { ...initialCoachState(), overriddenPhaseId: "close" };
    state = coachReducer(state, { type: "phase", phaseId: "reveal", ts: "t1" });
    expect(state.currentPhaseId).toBe("reveal");
    expect(state.overriddenPhaseId).toBeNull();
  });
});

describe("coachReducer — objection card lifecycle", () => {
  it("adds a card on an objection event and removes it on dismissal", () => {
    let state = coachReducer(initialCoachState(), {
      type: "objection",
      objectionId: "price_too_low",
      ts: "t1",
    });
    expect(state.objectionCards).toHaveLength(1);
    const cardId = state.objectionCards[0].id;

    state = coachReducer(state, { type: "dismiss_objection", cardId });
    expect(state.objectionCards).toHaveLength(0);
  });

  it("keeps distinct instances for the same objection fired twice", () => {
    let state = coachReducer(initialCoachState(), { type: "objection", objectionId: "not_in_rush", ts: "t1" });
    state = coachReducer(state, { type: "objection", objectionId: "not_in_rush", ts: "t2" });
    expect(state.objectionCards).toHaveLength(2);
    expect(state.objectionCards[0].id).not.toBe(state.objectionCards[1].id);
  });
});

describe("coachReducer — counters, gates, timers", () => {
  it("tracks the probe counter", () => {
    const state = coachReducer(initialCoachState(), { type: "counter", probeCount: 4, ts: "t1" });
    expect(state.probeCount).toBe(4);
  });

  it("tracks gate clearance by id", () => {
    let state = coachReducer(initialCoachState(), { type: "gate", gateId: "no_concerns", cleared: false, ts: "t1" });
    expect(state.gates.no_concerns).toBe(false);
    state = coachReducer(state, { type: "gate", gateId: "no_concerns", cleared: true, ts: "t2" });
    expect(state.gates.no_concerns).toBe(true);
  });

  it("records a hold timer", () => {
    const state = coachReducer(initialCoachState(), {
      type: "timer",
      timerId: "hold_timer",
      startedAt: "t1",
      durationS: 180,
      ts: "t1",
    });
    expect(state.holdTimer).toEqual({ timerId: "hold_timer", startedAt: "t1", durationS: 180 });
  });
});

describe("coachReducer — manual override", () => {
  it("sets a display-only override without touching currentPhaseId", () => {
    const state = coachReducer(initialCoachState(), { type: "override_phase", phaseId: "offer" });
    expect(state.overriddenPhaseId).toBe("offer");
    expect(state.currentPhaseId).toBe("introduction");
  });
});
