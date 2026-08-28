import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coachReducer, initialCoachState, MAX_NUDGES, MAX_OBJECTION_CARDS, NUDGE_TTL_MS, OBJECTION_CARD_TTL_MS } from "./event-reducer";
import { CLOSR_SCRIPT } from "./script-block";
import type { CoachState } from "./types";

/** Every wire event carries both content versions, always — required. */
const V = { scriptVersion: "1.0.1", matcherVersion: "3" };

/** Cursor-specific versions — a cursor is ONLY ever stored when scriptVersion
 * matches this client's loaded script (CLOSR_SCRIPT.version), unlike every
 * other event type, so cursor tests need the real, current version rather
 * than the arbitrary placeholder `V` uses. */
const CV = { scriptVersion: CLOSR_SCRIPT.version, matcherVersion: "3" };

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

describe("coachReducer — cursor", () => {
  it("starts with no cursor", () => {
    expect(initialCoachState().cursor).toBeNull();
  });

  it("stores a cursor whose phaseId matches the current phase and scriptVersion matches the loaded script", () => {
    const state = coachReducer(initialCoachState(), {
      type: "cursor",
      phaseId: "introduction",
      branchTag: "Frame the call",
      variantKey: "default",
      lineIndex: 2,
      lineText: "• To add some sort of value to the property so we can resell it on the market, or",
      ts: "t1",
      ...CV,
    });
    expect(state.cursor).toEqual({
      phaseId: "introduction",
      branchTag: "Frame the call",
      variantKey: "default",
      lineIndex: 2,
      lineText: "• To add some sort of value to the property so we can resell it on the market, or",
      scriptVersion: CV.scriptVersion,
      ts: "t1",
    });
    expect(state.connected).toBe(true);
  });

  it("ignores a cursor whose phaseId does not match the current phase — phase is authoritative", () => {
    const state = coachReducer(initialCoachState(), {
      type: "cursor",
      phaseId: "reveal",
      branchTag: "Entry",
      variantKey: "unknown",
      lineIndex: 0,
      lineText: "Ok Jane, that should be all you need for now.",
      ts: "t1",
      ...CV,
    });
    expect(state.cursor).toBeNull();
    // Nothing else about state should move either — this is a full ignore,
    // not a partial apply.
    expect(state.connected).toBe(false);
  });

  it("ignores a cursor whose scriptVersion doesn't match this client's loaded script — line addressing has no stable identity across a script edit", () => {
    const state = coachReducer(initialCoachState(), {
      type: "cursor",
      phaseId: "introduction",
      branchTag: "Opener",
      variantKey: "default",
      lineIndex: 0,
      lineText: "Hey {seller_name}? Hey {seller_name}, this is {rep_name}!",
      ts: "t1",
      scriptVersion: "0.0.1-not-the-loaded-script",
      matcherVersion: "3",
    });
    expect(state.cursor).toBeNull();
    expect(state.connected).toBe(false);
  });

  it("a later, non-matching cursor never overwrites a previously stored valid one", () => {
    let state = coachReducer(initialCoachState(), {
      type: "cursor",
      phaseId: "introduction",
      branchTag: "Opener",
      variantKey: "default",
      lineIndex: 0,
      lineText: "Hey {seller_name}? Hey {seller_name}, this is {rep_name}!",
      ts: "t1",
      ...CV,
    });
    // Neither a wrong-phase nor a wrong-version cursor should be able to
    // clobber the good one.
    state = coachReducer(state, {
      type: "cursor",
      phaseId: "reveal",
      branchTag: "Entry",
      variantKey: "unknown",
      lineIndex: 0,
      lineText: "Ok Jane, that should be all you need for now.",
      ts: "t2",
      ...CV,
    });
    state = coachReducer(state, {
      type: "cursor",
      phaseId: "introduction",
      branchTag: "Frame the call",
      variantKey: "default",
      lineIndex: 3,
      lineText: "some stale-version text",
      ts: "t3",
      scriptVersion: "0.0.1-not-the-loaded-script",
      matcherVersion: "3",
    });
    expect(state.cursor).toEqual({
      phaseId: "introduction",
      branchTag: "Opener",
      variantKey: "default",
      lineIndex: 0,
      lineText: "Hey {seller_name}? Hey {seller_name}, this is {rep_name}!",
      scriptVersion: CV.scriptVersion,
      ts: "t1",
    });
  });

  it("clears the cursor once a phase event actually advances the current phase", () => {
    let state = coachReducer(initialCoachState(), {
      type: "cursor",
      phaseId: "introduction",
      branchTag: "Opener",
      variantKey: "default",
      lineIndex: 0,
      lineText: "Hey {seller_name}? Hey {seller_name}, this is {rep_name}!",
      ts: "t1",
      ...CV,
    });
    expect(state.cursor).not.toBeNull();
    state = coachReducer(state, { type: "phase", phaseId: "reveal", ts: "t2", ...V });
    expect(state.cursor).toBeNull();
    expect(state.currentPhaseId).toBe("reveal");
  });

  it("keeps a valid cursor through a redundant phase event that repeats the SAME phaseId", () => {
    let state = coachReducer(initialCoachState(), {
      type: "cursor",
      phaseId: "introduction",
      branchTag: "Opener",
      variantKey: "default",
      lineIndex: 0,
      lineText: "Hey {seller_name}? Hey {seller_name}, this is {rep_name}!",
      ts: "t1",
      ...CV,
    });
    state = coachReducer(state, { type: "phase", phaseId: "introduction", ts: "t2", ...V });
    expect(state.cursor).not.toBeNull();
  });

  it("clears the cursor on reset, same as the rest of session state", () => {
    let state = coachReducer(initialCoachState(), {
      type: "cursor",
      phaseId: "introduction",
      branchTag: "Opener",
      variantKey: "default",
      lineIndex: 0,
      lineText: "Hey {seller_name}? Hey {seller_name}, this is {rep_name}!",
      ts: "t1",
      ...CV,
    });
    state = coachReducer(state, { type: "reset", startingPhaseId: "introduction" });
    expect(state.cursor).toBeNull();
  });

  it("does NOT clear the cursor on a local override_phase action — the rep browsing the rail is display-only and never reaches the server", () => {
    let state = coachReducer(initialCoachState(), {
      type: "cursor",
      phaseId: "introduction",
      branchTag: "Opener",
      variantKey: "default",
      lineIndex: 0,
      lineText: "Hey {seller_name}? Hey {seller_name}, this is {rep_name}!",
      ts: "t1",
      ...CV,
    });
    state = coachReducer(state, { type: "override_phase", phaseId: "close" });
    expect(state.cursor).not.toBeNull();
    expect(state.currentPhaseId).toBe("introduction");
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

  it(`caps at ${MAX_OBJECTION_CARDS} simultaneous cards, dropping the OLDEST — a state-level cap, not just presentational, so the guidance stack can never grow unbounded`, () => {
    let state = initialCoachState();
    const objectionIds = ["price_too_low", "not_in_rush", "end_buyer", "zillow_worth", "list_with_realtor"];
    for (const [index, objectionId] of objectionIds.entries()) {
      state = coachReducer(state, { type: "objection", objectionId, ts: `t${index}`, ...V });
    }
    expect(objectionIds.length).toBeGreaterThan(MAX_OBJECTION_CARDS); // the test actually exercises the cap
    expect(state.objectionCards).toHaveLength(MAX_OBJECTION_CARDS);
    // The most recent MAX_OBJECTION_CARDS survive, oldest-first order kept.
    expect(state.objectionCards.map((card) => card.objectionId)).toEqual(
      objectionIds.slice(objectionIds.length - MAX_OBJECTION_CARDS),
    );
  });

  it("gives every card a unique id even when five events share the exact same objectionId and ts — a length-based id would repeat once the cap starts dropping the oldest, and dismiss would remove more than one", () => {
    let state = initialCoachState();
    for (let i = 0; i < 5; i += 1) {
      state = coachReducer(state, { type: "objection", objectionId: "price_too_low", ts: "same-ts", ...V });
    }
    expect(state.objectionCards).toHaveLength(MAX_OBJECTION_CARDS);
    const ids = state.objectionCards.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);

    const [first] = state.objectionCards;
    state = coachReducer(state, { type: "dismiss_objection", cardId: first.id });
    expect(state.objectionCards).toHaveLength(MAX_OBJECTION_CARDS - 1);
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
      motivation: null,
      cold_caller_name: null,
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
    expect(state.entryFields).toEqual({
      motivation: null,
      cold_caller_name: null,
      closing_date: "Sept 15",
      offer_price: "$210,000",
      net_to_seller: null,
    });
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

  it(`caps at ${MAX_NUDGES} simultaneous nudges, dropping the OLDEST`, () => {
    let state = initialCoachState();
    const texts = ["A", "B", "C", "D", "E"];
    for (const [index, text] of texts.entries()) {
      state = coachReducer(state, { type: "coach_note", text, phaseId: "introduction", ts: `t${index}`, ...V });
    }
    expect(texts.length).toBeGreaterThan(MAX_NUDGES); // the test actually exercises the cap
    expect(state.nudges).toHaveLength(MAX_NUDGES);
    expect(state.nudges.map((nudge) => nudge.text)).toEqual(texts.slice(texts.length - MAX_NUDGES));
  });

  it("gives every nudge a unique id even when five events share the exact same ts and phaseId — a length-based id would repeat once the cap starts dropping the oldest, and dismiss would remove more than one", () => {
    let state = initialCoachState();
    const texts = ["A", "B", "C", "D", "E"];
    for (const text of texts) {
      state = coachReducer(state, { type: "coach_note", text, phaseId: "introduction", ts: "same-ts", ...V });
    }
    expect(state.nudges).toHaveLength(MAX_NUDGES);
    const ids = state.nudges.map((nudge) => nudge.id);
    expect(new Set(ids).size).toBe(ids.length);

    const [first] = state.nudges;
    state = coachReducer(state, { type: "dismiss_nudge", nudgeId: first.id });
    expect(state.nudges).toHaveLength(MAX_NUDGES - 1);
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
