import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coachReducer, initialCoachState, NUDGE_TTL_MS, OBJECTION_CARD_TTL_MS } from "./event-reducer";
import type { CoachState } from "./types";

/** Every wire event carries both content versions, always — required. */
const V = { scriptVersion: "1.0.1", matcherVersion: "3" };

describe("coachReducer — transcript", () => {
  it("appends a final line for a fresh speaker turn", () => {
    const state = coachReducer(initialCoachState(), {
      type: "transcript",
      speaker: "rep",
      text: "Hey Jane, this is Alex.",
      isFinal: true,
      ts: "2026-08-26T10:00:00Z",
      ...V,
    });
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({ speaker: "rep", text: "Hey Jane, this is Alex.", isFinal: true });
    expect(state.connected).toBe(true);
  });

  it("updates the trailing interim line in place instead of stacking duplicates", () => {
    let state = initialCoachState();
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "yeah I", isFinal: false, ts: "t1", ...V });
    state = coachReducer(state, {
      type: "transcript",
      speaker: "seller",
      text: "yeah I guess",
      isFinal: false,
      ts: "t2",
      ...V,
    });
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0].text).toBe("yeah I guess");
    expect(state.transcript[0].isFinal).toBe(false);

    state = coachReducer(state, {
      type: "transcript",
      speaker: "seller",
      text: "yeah I guess so",
      isFinal: true,
      ts: "t3",
      ...V,
    });
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({ text: "yeah I guess so", isFinal: true });
  });

  it("starts a new line once a final has landed, even for the same speaker", () => {
    let state = initialCoachState();
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "first", isFinal: true, ts: "t1", ...V });
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "second", isFinal: true, ts: "t2", ...V });
    expect(state.transcript).toHaveLength(2);
  });

  it("does not interleave a new speaker's interim line into the previous speaker's turn", () => {
    let state = initialCoachState();
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "hello", isFinal: false, ts: "t1", ...V });
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "hi", isFinal: false, ts: "t2", ...V });
    expect(state.transcript).toHaveLength(2);
    expect(state.transcript.map((line) => line.speaker)).toEqual(["rep", "seller"]);
  });

  it("updates the REP's own open interim line in place even after the SELLER's interim became the trailing line — per-speaker tracking, not last-line-only", () => {
    // Regression: rep-interim -> seller-interim -> rep-final used to check
    // only the trailing line in the whole transcript, which by this point
    // belongs to the seller — so the rep's final was wrongly appended as a
    // duplicate instead of updating the rep's still-open line at index 0.
    let state = initialCoachState();
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "hi there", isFinal: false, ts: "t1", ...V });
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "yeah", isFinal: false, ts: "t2", ...V });
    expect(state.transcript).toHaveLength(2);

    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "hi there, how are you", isFinal: true, ts: "t3", ...V });

    expect(state.transcript).toHaveLength(2);
    expect(state.transcript[0]).toMatchObject({ speaker: "rep", text: "hi there, how are you", isFinal: true });
    expect(state.transcript[1]).toMatchObject({ speaker: "seller", text: "yeah", isFinal: false });
  });

  it("starts a fresh line for a speaker whose most recent line is already final, even though it isn't the trailing line", () => {
    let state = initialCoachState();
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "first", isFinal: true, ts: "t1", ...V });
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "response", isFinal: false, ts: "t2", ...V });
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "second interim", isFinal: false, ts: "t3", ...V });

    expect(state.transcript).toHaveLength(3);
    expect(state.transcript.map((line) => ({ speaker: line.speaker, text: line.text, isFinal: line.isFinal }))).toEqual([
      { speaker: "rep", text: "first", isFinal: true },
      { speaker: "seller", text: "response", isFinal: false },
      { speaker: "rep", text: "second interim", isFinal: false },
    ]);
  });
});

describe("coachReducer — phase advance", () => {
  it("moves the current phase and clears any manual override", () => {
    let state: CoachState = { ...initialCoachState(), overriddenPhaseId: "close" };
    state = coachReducer(state, { type: "phase", phaseId: "reveal", ts: "t1", ...V });
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
      ...V,
    });
    expect(state.objectionCards).toHaveLength(1);
    const cardId = state.objectionCards[0].id;

    state = coachReducer(state, { type: "dismiss_objection", cardId });
    expect(state.objectionCards).toHaveLength(0);
  });

  it("keeps distinct instances for the same objection fired twice", () => {
    let state = coachReducer(initialCoachState(), { type: "objection", objectionId: "not_in_rush", ts: "t1", ...V });
    state = coachReducer(state, { type: "objection", objectionId: "not_in_rush", ts: "t2", ...V });
    expect(state.objectionCards).toHaveLength(2);
    expect(state.objectionCards[0].id).not.toBe(state.objectionCards[1].id);
  });

  describe("expiresAt — an absolute timestamp, not a relative TTL a remount could restart", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("sets expiresAt to insert-time-plus-TTL, not TTL alone", () => {
      vi.setSystemTime(1_000_000);
      const state = coachReducer(initialCoachState(), { type: "objection", objectionId: "price_too_low", ts: "t1", ...V });
      expect(state.objectionCards[0].expiresAt).toBe(1_000_000 + OBJECTION_CARD_TTL_MS);
    });

    it("stamps each card with its OWN insert time, not the first card's", () => {
      vi.setSystemTime(1_000_000);
      let state = coachReducer(initialCoachState(), { type: "objection", objectionId: "price_too_low", ts: "t1", ...V });
      vi.setSystemTime(1_010_000);
      state = coachReducer(state, { type: "objection", objectionId: "not_in_rush", ts: "t2", ...V });
      expect(state.objectionCards[0].expiresAt).toBe(1_000_000 + OBJECTION_CARD_TTL_MS);
      expect(state.objectionCards[1].expiresAt).toBe(1_010_000 + OBJECTION_CARD_TTL_MS);
    });
  });
});

describe("coachReducer — counters, gates, timers", () => {
  it("tracks the probe counter", () => {
    const state = coachReducer(initialCoachState(), { type: "counter", probeCount: 4, ts: "t1", ...V });
    expect(state.probeCount).toBe(4);
  });

  it("tracks gate clearance by id", () => {
    let state = coachReducer(initialCoachState(), { type: "gate", gateId: "no_concerns", cleared: false, ts: "t1", ...V });
    expect(state.gates.no_concerns).toBe(false);
    state = coachReducer(state, { type: "gate", gateId: "no_concerns", cleared: true, ts: "t2", ...V });
    expect(state.gates.no_concerns).toBe(true);
  });

  it("records a hold timer", () => {
    const state = coachReducer(initialCoachState(), {
      type: "timer",
      timerId: "hold_timer",
      startedAt: "t1",
      durationS: 180,
      ts: "t1",
      ...V,
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
      ...V,
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
      ...V,
    });
    state = coachReducer(state, { type: "coach_note", text: "Pain word — go deeper.", phaseId: "reveal", ts: "t2", ...V });
    expect(state.nudges).toHaveLength(2);
    expect(state.nudges[0].id).not.toBe(state.nudges[1].id);
  });

  it("removes a nudge on dismiss_nudge without touching others", () => {
    let state = coachReducer(initialCoachState(), { type: "coach_note", text: "A", phaseId: "introduction", ts: "t1", ...V });
    state = coachReducer(state, { type: "coach_note", text: "B", phaseId: "introduction", ts: "t2", ...V });
    const [first, second] = state.nudges;
    state = coachReducer(state, { type: "dismiss_nudge", nudgeId: first.id });
    expect(state.nudges).toEqual([second]);
  });

  describe("expiresAt — an absolute timestamp, not a relative TTL a remount could restart", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("sets expiresAt to insert-time-plus-TTL, not TTL alone", () => {
      vi.setSystemTime(2_000_000);
      const state = coachReducer(initialCoachState(), { type: "coach_note", text: "A", phaseId: "introduction", ts: "t1", ...V });
      expect(state.nudges[0].expiresAt).toBe(2_000_000 + NUDGE_TTL_MS);
    });
  });
});
