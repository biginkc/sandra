import { describe, expect, it } from "vitest";

import { filterLeads, type SearchableLead } from "./filter";

// Phase 02 (D-05 coexistence): 2 fixtures use county-shaped market strings
// (new vocabulary post-migration-046); 1 fixture keeps the legacy "Kansas City"
// string (intentional — 1,437 prod properties still carry this value and the
// filter must tolerate both vocabularies simultaneously).
const leads: SearchableLead[] = [
  {
    address: "123 Main St",
    city: "Independence",
    state: "MO",
    zip: "64055",
    market: "Jackson County MO",
    homeowner: { first_name: "John", last_name: "Smith", entity_name: null },
  },
  {
    address: "456 Oak Ave",
    city: "Olathe",
    state: "KS",
    zip: "66061",
    market: "Johnson County KS",
    homeowner: { first_name: "Jane", last_name: "Doe", entity_name: null },
  },
  {
    address: "789 Pine Rd",
    city: "Kansas City",
    state: "MO",
    zip: "64108",
    market: "Kansas City",
    homeowner: { first_name: null, last_name: null, entity_name: "Acme Holdings LLC" },
  },
  {
    address: "12 Elm Ct",
    city: null,
    state: "MO",
    zip: null,
    market: null,
    homeowner: null,
  },
];

describe("filterLeads", () => {
  it("returns a full copy when query is empty", () => {
    const result = filterLeads(leads, "");
    expect(result).toHaveLength(leads.length);
    // Ensure we returned a new array, not the input reference
    expect(result).not.toBe(leads);
  });

  it("treats whitespace-only as empty (no filter)", () => {
    expect(filterLeads(leads, "   ")).toHaveLength(leads.length);
    expect(filterLeads(leads, "\t\n ")).toHaveLength(leads.length);
  });

  it("matches a single token case-insensitively", () => {
    const result = filterLeads(leads, "main");
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe("123 Main St");
  });

  it("matches across different fields (address, city, market)", () => {
    // "kansas" matches Lead 2's city ("Kansas City") and market ("Kansas City")
    expect(filterLeads(leads, "kansas")).toHaveLength(1);
    // "dayton" no longer appears in any fixture — legacy city-shaped market removed per phase 02
    expect(filterLeads(leads, "dayton")).toHaveLength(0);
    // state "MO" appears on Lead 0 (Jackson County MO), Lead 2 (Kansas City), Lead 3 (null city)
    expect(filterLeads(leads, "MO")).toHaveLength(3);
  });

  it("matches on ZIP", () => {
    // Lead 2 carries zip 64108 (Kansas City MO) — legacy fixture retained per D-05
    const result = filterLeads(leads, "64108");
    expect(result).toHaveLength(1);
    expect(result[0].city).toBe("Kansas City");
  });

  it("AND-s multiple tokens — all must match somewhere", () => {
    // "jackson" + "main": Lead 0 has market "Jackson County MO" and address "123 Main St" → match
    expect(filterLeads(leads, "jackson main")).toHaveLength(1);
    expect(filterLeads(leads, "main olathe")).toHaveLength(0);
    // "MO" + "st": Lead 0 has state "MO" and address "123 Main St" → 1 match
    expect(filterLeads(leads, "MO st")).toHaveLength(1); // matches '123 Main St' (MO state + "st" in address)
  });

  it("returns empty array when no lead matches", () => {
    expect(filterLeads(leads, "nonsense")).toHaveLength(0);
  });

  it("tolerates null fields without throwing", () => {
    const result = filterLeads(leads, "elm");
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe("12 Elm Ct");
  });

  it("does not mutate the input array", () => {
    const input = [...leads];
    filterLeads(input, "main");
    expect(input).toEqual(leads);
  });

  it("matches on homeowner first name", () => {
    // "john smith" ANDs both tokens: "john" in first_name + "smith" in last_name → only Lead 0.
    // NOTE: "john" alone would also match Lead 1's market "Johnson County KS" (substring),
    // so we use two tokens to isolate the homeowner-name assertion.
    const result = filterLeads(leads, "john smith");
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe("123 Main St");
  });

  it("matches on homeowner last name", () => {
    const result = filterLeads(leads, "doe");
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe("456 Oak Ave");
  });

  it("matches on entity name (LLC / trust)", () => {
    const result = filterLeads(leads, "acme");
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe("789 Pine Rd");
  });

  it("AND-s multi-token across address + owner name", () => {
    // "jackson smith": Lead 0 has market "Jackson County MO" + last_name "Smith" → 1 match
    expect(filterLeads(leads, "jackson smith")).toHaveLength(1);
    // "olathe smith": "Olathe" is Lead 1's city, "Smith" is Lead 0's name — no single lead has both → 0
    expect(filterLeads(leads, "olathe smith")).toHaveLength(0);
  });

  it("tolerates leads with null homeowner", () => {
    // 12 Elm Ct has homeowner: null. A non-owner search should still find
    // it; an owner-only search should not.
    expect(filterLeads(leads, "elm")).toHaveLength(1);
    expect(filterLeads(leads, "smith")).toHaveLength(1); // matches Smith on 123 Main, not Elm
  });
});
