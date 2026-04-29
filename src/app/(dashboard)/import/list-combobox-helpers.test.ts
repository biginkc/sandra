import { describe, expect, it } from "vitest";

import { classifyListQuery, type ListEntry } from "./list-combobox-helpers";

const lists: ListEntry[] = [
  { id: "1", name: "Absentee Low Equity" },
  { id: "2", name: "Pre-Foreclosure" },
  { id: "3", name: "Tired Landlord" },
];

describe("classifyListQuery", () => {
  it("returns all lists with no match/create when the query is empty", () => {
    const r = classifyListQuery("", lists);
    expect(r.trimmed).toBe("");
    expect(r.matches).toHaveLength(3);
    expect(r.exactMatch).toBe(false);
    expect(r.canCreate).toBe(false);
  });

  it("trims whitespace from the query before matching", () => {
    const r = classifyListQuery("  Pre-Foreclosure  ", lists);
    expect(r.trimmed).toBe("Pre-Foreclosure");
    expect(r.exactMatch).toBe(true);
  });

  it("matches case-insensitively on a partial substring", () => {
    const r = classifyListQuery("absent", lists);
    expect(r.matches.map((m) => m.name)).toEqual(["Absentee Low Equity"]);
    expect(r.exactMatch).toBe(false);
    expect(r.canCreate).toBe(true);
  });

  it("flags exact (case-insensitive) match and disables create", () => {
    const r = classifyListQuery("absentee low equity", lists);
    expect(r.exactMatch).toBe(true);
    expect(r.canCreate).toBe(false);
    expect(r.matches.map((m) => m.name)).toContain("Absentee Low Equity");
  });

  it("returns no matches and allows create on a brand-new name", () => {
    const r = classifyListQuery("Probate Q2", lists);
    expect(r.matches).toHaveLength(0);
    expect(r.exactMatch).toBe(false);
    expect(r.canCreate).toBe(true);
  });

  it("doesn't choke on an empty list set", () => {
    const r = classifyListQuery("Probate", []);
    expect(r.matches).toHaveLength(0);
    expect(r.canCreate).toBe(true);
  });

  it("preserves match order from the input list", () => {
    // Two lists both contain "list" — return them in input order.
    const customLists: ListEntry[] = [
      { id: "1", name: "Beta List" },
      { id: "2", name: "Alpha List" },
    ];
    const r = classifyListQuery("list", customLists);
    expect(r.matches.map((m) => m.name)).toEqual(["Beta List", "Alpha List"]);
  });
});
