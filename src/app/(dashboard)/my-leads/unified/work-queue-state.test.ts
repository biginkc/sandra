import { describe, expect, it } from "vitest";
import {
  afterActionDecision,
  applyCountsOnly,
  applyFacts,
  chunk,
  initialState,
  markChanged,
  placementMatches,
  swapIn,
  visibleRows,
} from "./work-queue-state";
import { Q, makeServer, mkFacts } from "./work-queue-fixtures";

describe("placementMatches", () => {
  it("applies tab, chip and stage", () => {
    const f = mkFacts("a", { place: "your_move", reason: "due", stage: "contacted" });
    expect(placementMatches(f, Q())).toBe(true);
    expect(placementMatches(f, Q({ tab: "waiting" }))).toBe(false);
    expect(placementMatches(f, Q({ tab: "all" }))).toBe(true);
    expect(placementMatches(f, Q({ chip: "due" }))).toBe(true);
    expect(placementMatches(f, Q({ chip: "new_reply" }))).toBe(false);
    expect(placementMatches(f, Q({ stage: "offer_sent" }))).toBe(false);
  });
});

describe("afterActionDecision", () => {
  it("names the tab the lead moved to", () => {
    const f = mkFacts("a", { place: "their_move", reason: "texted_last" });
    expect(afterActionDecision(f, Q())).toEqual({ keep: false, notice: "Moved to Waiting on them" });
    expect(afterActionDecision(mkFacts("a", { place: "neither" }), Q())).toEqual({ keep: false, notice: "Moved to All leads" });
    expect(afterActionDecision(mkFacts("a"), Q())).toEqual({ keep: true });
  });
});

describe("chunk", () => {
  it("splits into chunks of at most 50", () => {
    const parts = chunk(Array.from({ length: 120 }, (_, i) => i));
    expect(parts.map((p) => p.length)).toEqual([50, 50, 20]);
  });
});

describe("counts are never mixed across responses", () => {
  it("markChanged / applyCountsOnly take all three count sets from the one page", () => {
    const server = makeServer(2).addMany("L", 3);
    const state = initialState(server.initial(Q()));
    server.add("W", { place: "their_move", reason: "in_drip", stage: "offer_sent" });
    const newer = server.page(Q());
    for (const next of [markChanged(state, newer), applyCountsOnly(state, newer)]) {
      expect(next.tabCounts).toEqual(newer.tabCounts);
      expect(next.chipCounts).toEqual(newer.chipCounts);
      expect(next.stageCounts).toEqual(newer.stageCounts);
    }
  });
});

describe("swapIn / applyFacts / visibleRows", () => {
  it("adopts a clamped page and clears retained flags", () => {
    const server = makeServer(2).addMany("L", 3);
    const state = initialState(server.initial(Q()));
    const next = swapIn(state, server.page(Q({ page: 7 })), Q({ page: 7 }));
    expect(next.query.page).toBe(2);
    expect(next.displayedKey).toContain("2");
    expect(next.leftView).toEqual([]);
  });

  it("flags rows whose placement left the view without removing them", () => {
    const server = makeServer().addMany("L", 2);
    const state = initialState(server.initial(Q()));
    const next = applyFacts(state, [mkFacts("L2", { place: "their_move" })], []);
    expect(visibleRows(next).map((r) => [r.facts.propertyId, r.leftView])).toEqual([["L1", false], ["L2", true]]);
  });
});
