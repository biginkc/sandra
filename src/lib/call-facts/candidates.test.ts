import { describe, expect, it } from "vitest";

import { findAmountCandidates, findDateCandidates, parseTurns, resolveDatePhrase, turnState } from "./candidates";

const NOW = new Date("2026-10-07T15:00:00Z"); // Wed 2026-10-07 Central
const TODAY = { y: 2026, m: 10, d: 7 };

describe("parseTurns", () => {
  it("labels transcript lines T001... with their speaker and text", () => {
    const turns = parseTurns({ summary: "s", transcript: "Other party: hi\n\nRep: $185,000 works" });
    expect(turns.map((t) => [t.label, t.speaker, t.text])).toEqual([["T001", "Other party", "hi"], ["T002", "Rep", "$185,000 works"]]);
    expect(turnState(turns)).toBe("T001 | Other party: hi\nT002 | Rep: $185,000 works");
  });
  it("falls back to summary lines, and yields nothing for empty input", () => {
    expect(parseTurns({ summary: "one\ntwo", transcript: " " }).map((t) => t.label)).toEqual(["T001", "T002"]);
    expect(parseTurns({ summary: null, transcript: null })).toEqual([]);
  });
});

describe("findAmountCandidates", () => {
  it("over-finds dollar amounts per turn and dedupes within a turn", () => {
    const turns = parseTurns({ summary: null, transcript: "A: I owe $92,000.50, maybe 92k, want 185 thousand, $92,000.50 again, 2 loans" });
    expect(findAmountCandidates(turns).map((c) => c.raw)).toEqual(["$92,000.50", "92k", "185 thousand"]);
  });
});

describe("resolveDatePhrase / findDateCandidates", () => {
  it("resolves ISO, month-day, numeric and relative phrases in Central time", () => {
    expect(resolveDatePhrase("2026-10-13", TODAY)).toBe("2026-10-13");
    expect(resolveDatePhrase("October 13th", TODAY)).toBe("2026-10-13");
    expect(resolveDatePhrase("oct. 2", TODAY)).toBe("2027-10-02"); // already past this year
    expect(resolveDatePhrase("10/13", TODAY)).toBe("2026-10-13");
    expect(resolveDatePhrase("10/13/27", TODAY)).toBe("2027-10-13");
    expect(resolveDatePhrase("tomorrow", TODAY)).toBe("2026-10-08");
    expect(resolveDatePhrase("friday", TODAY)).toBe("2026-10-09");
    expect(resolveDatePhrase("next friday", TODAY)).toBe("2026-10-16");
    expect(resolveDatePhrase("next monday", TODAY)).toBe("2026-10-12");
    expect(resolveDatePhrase("wednesday", TODAY)).toBe("2026-10-14");
    expect(resolveDatePhrase("13/45", TODAY)).toBeNull();
    expect(resolveDatePhrase("february 30", TODAY)).toBeNull();
  });
  it("offers only phrases that resolve, once per turn", () => {
    const turns = parseTurns({ summary: null, transcript: "A: call me Friday, or friday, or 13/45, or May 2" });
    expect(findDateCandidates(turns, NOW).map((c) => [c.raw, c.date])).toEqual([["Friday", "2026-10-09"], ["May 2", "2027-05-02"]]);
  });
});
