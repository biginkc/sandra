import { describe, expect, it } from "vitest";

import { filterLeads, type SearchableLead } from "./filter";

const leads: SearchableLead[] = [
  {
    address: "123 Main St",
    city: "Kansas City",
    state: "MO",
    zip: "64108",
    market: "Kansas City",
    homeowner: { first_name: "John", last_name: "Smith", entity_name: null },
  },
  {
    address: "456 Oak Ave",
    city: "St. Louis",
    state: "MO",
    zip: "63101",
    market: "St. Louis",
    homeowner: { first_name: "Jane", last_name: "Doe", entity_name: null },
  },
  {
    address: "789 Pine Rd",
    city: "Dayton",
    state: "OH",
    zip: "45401",
    market: "Dayton",
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
    expect(filterLeads(leads, "kansas")).toHaveLength(1);
    expect(filterLeads(leads, "dayton")).toHaveLength(1);
    expect(filterLeads(leads, "MO")).toHaveLength(3);
  });

  it("matches on ZIP", () => {
    const result = filterLeads(leads, "63101");
    expect(result).toHaveLength(1);
    expect(result[0].city).toBe("St. Louis");
  });

  it("AND-s multiple tokens — all must match somewhere", () => {
    expect(filterLeads(leads, "kansas main")).toHaveLength(1);
    expect(filterLeads(leads, "main dayton")).toHaveLength(0);
    expect(filterLeads(leads, "MO st")).toHaveLength(2); // matches '123 Main St' + '456 Oak Ave/St. Louis'
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
    const result = filterLeads(leads, "john");
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
    expect(filterLeads(leads, "kansas smith")).toHaveLength(1);
    expect(filterLeads(leads, "dayton smith")).toHaveLength(0);
  });

  it("tolerates leads with null homeowner", () => {
    // 12 Elm Ct has homeowner: null. A non-owner search should still find
    // it; an owner-only search should not.
    expect(filterLeads(leads, "elm")).toHaveLength(1);
    expect(filterLeads(leads, "smith")).toHaveLength(1); // matches Smith on 123 Main, not Elm
  });
});
