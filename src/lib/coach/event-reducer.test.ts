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

describe("coachReducer — entry fields (deal-panel tokens)", () => {
  it("starts with every entry field unset", () => {
    expect(initialCoachState().entryFields).toEqual({
      closing_date: null,
      offer_price: null,
      net_to_seller: null,
    });
  });

  it("sets one entry field without touching the others", () => {
    let state = coachReducer(initialCoachState(), { type: "set_entry_field", field: "offer_price", value: "$210,000" });
    expect(state.entryFields.offer_price).toBe("$210,000");
    expect(state.entryFields.closing_date).toBeNull();

    state = coachReducer(state, { type: "set_entry_field", field: "closing_date", value: "Sept 15" });
    expect(state.entryFields).toEqual({ closing_date: "Sept 15", offer_price: "$210,000", net_to_seller: null });
  });

  it("trims whitespace and treats a blank value as clearing the field", () => {
    let state = coachReducer(initialCoachState(), { type: "set_entry_field", field: "net_to_seller", value: "  $180,000  " });
    expect(state.entryFields.net_to_seller).toBe("$180,000");

    state = coachReducer(state, { type: "set_entry_field", field: "net_to_seller", value: "   " });
    expect(state.entryFields.net_to_seller).toBeNull();
  });
});

describe("coachReducer — coach_note nudges", () => {
  it("starts with no nudges", () => {
    expect(initialCoachState().nudges).toEqual([]);
  });

  it("appends a nudge on a coach_note event", () => {
    const state = coachReducer(initialCoachState(), {
      type: "coach_note",
      text: "Say their name twice in the first line.",
      phaseId: "introduction",
      ts: "t1",
    });
    expect(state.nudges).toHaveLength(1);
    expect(state.nudges[0]).toMatchObject({ text: "Say their name twice in the first line.", phaseId: "introduction" });
    expect(state.connected).toBe(true);
  });

  it("keeps distinct instances for repeated coach_note text", () => {
    let state = coachReducer(initialCoachState(), {
      type: "coach_note",
      text: "Pain word — go deeper.",
      phaseId: "reveal",
      ts: "t1",
    });
    state = coachReducer(state, { type: "coach_note", text: "Pain word — go deeper.", phaseId: "reveal", ts: "t2" });
    expect(state.nudges).toHaveLength(2);
    expect(state.nudges[0].id).not.toBe(state.nudges[1].id);
  });

  it("removes a nudge on dismiss_nudge without touching others", () => {
    let state = coachReducer(initialCoachState(), { type: "coach_note", text: "A", phaseId: "introduction", ts: "t1" });
    state = coachReducer(state, { type: "coach_note", text: "B", phaseId: "introduction", ts: "t2" });
    const [first, second] = state.nudges;
    state = coachReducer(state, { type: "dismiss_nudge", nudgeId: first.id });
    expect(state.nudges).toEqual([second]);
  });

  it("uses the producer's noteId as the nudge id when given", () => {
    const state = coachReducer(initialCoachState(), {
      type: "coach_note",
      noteId: "note-42",
      text: "Pain word — go deeper.",
      phaseId: "reveal",
      ts: "t1",
    });
    expect(state.nudges[0].id).toBe("note-42");
  });

  it("stores a null phaseId when the event doesn't carry one — not every nudge is phase-scoped", () => {
    const state = coachReducer(initialCoachState(), { type: "coach_note", text: "Pain word — go deeper.", ts: "t1" });
    expect(state.nudges[0].phaseId).toBeNull();
  });
});
