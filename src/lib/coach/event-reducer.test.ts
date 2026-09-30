import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closrOutbound123Bundle } from "@biginkc/coach/fixtures";
import { createCoachReducer, initialCoachState, MAX_NUDGES, MAX_OBJECTION_CARDS, NUDGE_TTL_MS, OBJECTION_CARD_TTL_MS } from "./event-reducer";
import type { CoachState } from "./types";

/** Every wire event carries both content versions, always — required. */
const V = { scriptVersion: "1.0.1", matcherVersion: "3" };

/** Cursor-specific versions — a cursor is ONLY ever stored when scriptVersion
 * matches this client's loaded script (CLOSR_SCRIPT.version), unlike every
 * other event type, so cursor tests need the real, current version rather
 * than the arbitrary placeholder `V` uses. */
const CV = { scriptVersion: closrOutbound123Bundle.script.version, matcherVersion: "3" };
const coachReducer = createCoachReducer(closrOutbound123Bundle);

describe("coachReducer — objection prompt", () => {
  const prompt = { type: "objection_prompt" as const, objectionId: "price", label: "Price concern", sellerTurn: 1, classifierModel: "jev-1.13.0", questionsSha256: "a".repeat(64), ts: "2026-09-29T12:00:00Z", ...V };
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => vi.useRealTimers());

  it("sets, replaces, persists, dismisses, and resets the single prompt", () => {
    expect(initialCoachState().objectionPrompt).toBeNull();
    let state = coachReducer(initialCoachState(), prompt);
    expect(state.objectionPrompt).toMatchObject({ label: "Price concern" });
    vi.setSystemTime(1_010_000);
    state = coachReducer(state, { ...prompt, label: "Timing concern", sellerTurn: 2 });
    expect(state.objectionPrompt).toMatchObject({ label: "Timing concern" });
    vi.setSystemTime(1_040_000);
    expect(state.objectionPrompt).not.toHaveProperty("expiresAt");
    expect(state.objectionPrompt?.label).toBe("Timing concern");
    state = coachReducer(state, { type: "dismiss_objection_prompt" });
    expect(state.objectionPrompt).toBeNull();
    state = coachReducer(state, prompt);
    state = coachReducer(state, { type: "reset", startingPhaseId: "introduction" });
    expect(state.objectionPrompt).toBeNull();
  });

  it("does not duplicate an exact prompt or let an older prompt replace a newer one", () => {
    const newer = { ...prompt, label: "Timing concern", sellerTurn: 2, ts: "2026-09-29T12:00:10Z" };
    let state = coachReducer(initialCoachState(), newer);
    const afterDuplicate = coachReducer(state, newer);

    expect(afterDuplicate).toBe(state);

    state = coachReducer(state, {
      ...prompt,
      label: "Price concern",
      sellerTurn: 1,
      ts: "2026-09-29T12:00:09Z",
    });
    expect(state.objectionPrompt).toMatchObject({ label: "Timing concern", sellerTurn: 2, ts: newer.ts });
  });

  it("replaces a same-turn prompt of a different type even when timestamps tie", () => {
    const ts = "2026-09-29T12:00:00.000Z";
    let state = coachReducer(initialCoachState(), { ...prompt, objectionId: "price", label: "Price concern", sellerTurn: 200, ts });
    state = coachReducer(state, { ...prompt, objectionId: "timing", label: "Timing concern", sellerTurn: 200, ts });
    expect(state.objectionPrompt).toMatchObject({ objectionId: "timing", label: "Timing concern" });

    state = coachReducer(state, { ...prompt, objectionId: "consult", label: "Consult", sellerTurn: 199, ts });
    expect(state.objectionPrompt).toMatchObject({ objectionId: "timing" });
  });
});

describe("coachReducer — motivation prompt", () => {
  const motivation = { type: "motivation_prompt" as const, label: "Motivation", sellerTurn: 2, classifierModel: "jev-1.13.0", questionsSha256: "a".repeat(64), ts: "2026-09-29T12:00:00Z", ...V };
  const objection = { type: "objection_prompt" as const, objectionId: "price", label: "Price concern", sellerTurn: 2, classifierModel: "jev-1.13.0", questionsSha256: "a".repeat(64), ts: "2026-09-29T12:00:00Z", ...V };
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => vi.useRealTimers());

  it("keeps motivation separate from the objection card and resets it", () => {
    expect(initialCoachState().motivationPrompt).toBeNull();
    let state = coachReducer(initialCoachState(), objection);
    state = coachReducer(state, motivation);
    expect(state.objectionPrompt).toMatchObject({ label: "Price concern" });
    expect(state.motivationPrompt).toMatchObject({ label: "Motivation", sellerTurn: 2 });
    vi.setSystemTime(1_040_000);
    expect(state.motivationPrompt).not.toHaveProperty("expiresAt");
    state = coachReducer(state, { type: "dismiss_motivation_prompt" });
    expect(state.motivationPrompt).toBeNull();
    expect(state.objectionPrompt).not.toBeNull();
    state = coachReducer(state, motivation);
    state = coachReducer(state, { type: "reset", startingPhaseId: "introduction" });
    expect(state.motivationPrompt).toBeNull();
  });

  it("stores the sub-type and lets a same-timestamp different sub-type replace the card", () => {
    let state = coachReducer(initialCoachState(), motivation);
    expect(state.motivationPrompt).not.toHaveProperty("subType");
    state = coachReducer(state, { ...motivation, subType: "inherited" });
    expect(state.motivationPrompt).toMatchObject({ subType: "inherited" });
    expect(coachReducer(state, { ...motivation, subType: "inherited" })).toBe(state);
  });

  it("ignores an exact duplicate and an older motivation event, accepts a newer one", () => {
    let state = coachReducer(initialCoachState(), motivation);
    vi.setSystemTime(1_005_000);
    expect(coachReducer(state, motivation)).toBe(state);
    expect(coachReducer(state, { ...motivation, ts: "2026-09-29T11:59:59Z", sellerTurn: 3 })).toBe(state);
    expect(coachReducer(state, { ...motivation, sellerTurn: 1 })).toBe(state);
    state = coachReducer(state, { ...motivation, ts: "2026-09-29T12:00:05Z", sellerTurn: 4 });
    expect(state.motivationPrompt).toMatchObject({ sellerTurn: 4 });
  });
});

describe("coachReducer — a dismissed card stays dismissed", () => {
  const objection = { type: "objection_prompt" as const, objectionId: "price", label: "Price concern", sellerTurn: 2, classifierModel: "jev-1.13.0", questionsSha256: "a".repeat(64), ts: "2026-09-29T12:00:00Z", ...V };
  const motivation = { type: "motivation_prompt" as const, label: "Motivation", sellerTurn: 2, classifierModel: "jev-1.13.0", questionsSha256: "a".repeat(64), ts: "2026-09-29T12:00:00Z", ...V };

  it.each([
    ["objection", objection, { type: "dismiss_objection_prompt" as const }, "objectionPrompt" as const],
    ["motivation", motivation, { type: "dismiss_motivation_prompt" as const }, "motivationPrompt" as const],
  ])("%s: a duplicate or older event cannot bring it back, a newer one shows, reset forgets", (_kind, event, dismiss, field) => {
    let state = coachReducer(initialCoachState(), event);
    state = coachReducer(state, dismiss);
    expect(state[field]).toBeNull();
    expect(coachReducer(state, event)[field]).toBeNull();
    expect(coachReducer(state, { ...event, ts: "2026-09-29T11:59:00Z", sellerTurn: 9 })[field]).toBeNull();
    // Jitter's re-send after a failed publish: same card, same statement, fresh ts.
    const resent = coachReducer(state, { ...event, ts: "2026-09-29T12:00:01Z" });
    expect(resent[field]).toBeNull();
    // ...and a slower card stamped before that re-send is still older.
    expect(coachReducer(resent, { ...event, ts: "2026-09-29T12:00:00.500Z", sellerTurn: 9 })[field]).toBeNull();
    expect(coachReducer(state, { ...event, sellerTurn: 1 })[field]).toBeNull();
    const newer = coachReducer(state, { ...event, ts: "2026-09-29T12:00:30Z", sellerTurn: 4 });
    expect(newer[field]).toMatchObject({ sellerTurn: 4 });
    const reset = coachReducer(state, { type: "reset", startingPhaseId: "introduction" });
    expect(coachReducer(reset, event)[field]).toMatchObject({ sellerTurn: 2 });
  });
});

describe("coachReducer — a re-sent card is the same card", () => {
  const objection = { type: "objection_prompt" as const, objectionId: "price", label: "Price concern", sellerTurn: 2, classifierModel: "jev-1.13.0", questionsSha256: "a".repeat(64), ts: "2026-09-29T12:00:00Z", ...V };
  const motivation = { type: "motivation_prompt" as const, label: "Motivation", subType: "inherited", sellerTurn: 2, classifierModel: "jev-1.13.0", questionsSha256: "a".repeat(64), ts: "2026-09-29T12:00:00Z", ...V };
  const later = "2026-09-29T12:00:01Z";

  it("keeps the visible card object when the same card is re-sent with a later ts", () => {
    const shown = coachReducer(coachReducer(initialCoachState(), objection), motivation);
    const resent = coachReducer(coachReducer(shown, { ...objection, ts: later }), { ...motivation, ts: later });
    expect(resent.objectionPrompt).toBe(shown.objectionPrompt);
    expect(resent.motivationPrompt).toBe(shown.motivationPrompt);
  });

  it("shows a different card on the same statement, and the first one again if it comes back after it", () => {
    let state = coachReducer(coachReducer(initialCoachState(), objection), motivation);
    state = coachReducer(state, { ...objection, objectionId: "timing", label: "Timing concern", ts: later });
    state = coachReducer(state, { ...motivation, subType: "vacant", ts: later });
    expect(state.objectionPrompt).toMatchObject({ objectionId: "timing" });
    expect(state.motivationPrompt).toMatchObject({ subType: "vacant" });
    state = coachReducer(state, { ...motivation, ts: "2026-09-29T12:00:02Z" });
    expect(state.motivationPrompt).toMatchObject({ subType: "inherited" });
  });

  it("keeps a dismissed sub-type card hidden when the general card for that statement arrives, but shows a sub-type after a general", () => {
    const { subType: _subType, ...general } = motivation;
    let state = coachReducer(coachReducer(initialCoachState(), motivation), { type: "dismiss_motivation_prompt" });
    expect(coachReducer(state, { ...general, ts: later }).motivationPrompt).toBeNull();
    state = coachReducer(coachReducer(initialCoachState(), general), { ...motivation, ts: later });
    expect(state.motivationPrompt).toMatchObject({ subType: "inherited" });
  });
});

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

  it("groups consecutive finalized fragments from one speaker into one readable turn", () => {
    let state = initialCoachState();
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "first", isFinal: true, ts: "t1", ...V });
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "second", isFinal: true, ts: "t2", ...V });
    expect(state.transcript).toEqual([
      expect.objectContaining({ speaker: "rep", text: "first second", isFinal: true, ts: "t2" }),
    ]);
    expect(state.transcriptFragments.map(({ text, isFinal }) => ({ text, isFinal }))).toEqual([
      { text: "first", isFinal: true },
      { text: "second", isFinal: true },
    ]);
  });

  it("does not erase repeated finalized words while grouping", () => {
    let state = initialCoachState();
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "very", isFinal: true, ts: "t1", ...V });
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "very", isFinal: true, ts: "t2", ...V });
    expect(state.transcript[0].text).toBe("very very");
  });

  it("keeps finalized seller truth eligible while a same-speaker interim is live, then folds it without duplication", () => {
    let state = initialCoachState();
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "I need", isFinal: true, ts: "t1", ...V });
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "to sell", isFinal: false, ts: "t2", ...V });
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "to sell soon", isFinal: false, ts: "t3", ...V });
    expect(state.transcript).toEqual([
      expect.objectContaining({ text: "I need", isFinal: true, ts: "t1" }),
      expect.objectContaining({ text: "to sell soon", isFinal: false, ts: "t3" }),
    ]);
    expect(state.transcript.filter((line) => line.isFinal && line.speaker === "seller")).toEqual([
      expect.objectContaining({ text: "I need" }),
    ]);

    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "to sell soon", isFinal: true, ts: "t4", ...V });
    expect(state.transcript).toEqual([
      expect.objectContaining({ text: "I need to sell soon", isFinal: true, ts: "t4" }),
    ]);
    expect(state.transcriptFragments).toHaveLength(2);
  });

  it("starts a new grouped turn only when the other speaker begins", () => {
    let state = initialCoachState();
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "one", isFinal: true, ts: "t1", ...V });
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "two", isFinal: true, ts: "t2", ...V });
    state = coachReducer(state, { type: "transcript", speaker: "seller", text: "three", isFinal: true, ts: "t3", ...V });
    state = coachReducer(state, { type: "transcript", speaker: "rep", text: "four", isFinal: true, ts: "t4", ...V });
    expect(state.transcript.map(({ speaker, text }) => ({ speaker, text }))).toEqual([
      { speaker: "rep", text: "one two" },
      { speaker: "seller", text: "three" },
      { speaker: "rep", text: "four" },
    ]);
  });

  it("keeps the existing 500-fragment transcript bound after grouping", () => {
    let state = initialCoachState();
    for (let index = 0; index < 501; index += 1) {
      state = coachReducer(state, {
        type: "transcript",
        speaker: index % 2 === 0 ? "rep" : "seller",
        text: `fragment-${index}`,
        isFinal: true,
        ts: `t${index}`,
        ...V,
      });
    }
    expect(state.transcriptFragments).toHaveLength(500);
    expect(state.transcript).toHaveLength(500);
    expect(state.transcriptFragments[0].text).toBe("fragment-1");
    expect(state.transcript.at(-1)?.text).toBe("fragment-500");
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
    expect(state.transcriptFragments.map((line) => line.speaker)).toEqual(["rep", "seller"]);
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
      dream_outcome: null,
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
      dream_outcome: null,
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
