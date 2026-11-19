import { describe, expect, it } from "vitest";

import { resolveSellerZone } from "./seller-timezone";

describe("resolveSellerZone (Master A-005)", () => {
  it("single-zone states use the state table", () => {
    expect(resolveSellerZone({ state: "MO", fips: null })).toEqual({ kind: "zone", zone: "America/Chicago" });
    expect(resolveSellerZone({ state: " oh ", fips: null })).toEqual({ kind: "zone", zone: "America/New_York" });
  });

  it("Kansas: Central county, Mountain counties, unknown county", () => {
    expect(resolveSellerZone({ state: "KS", fips: "20091" })).toEqual({ kind: "zone", zone: "America/Chicago" }); // Johnson
    for (const f of ["20071", "20075", "20181", "20199"]) {
      expect(resolveSellerZone({ state: "KS", fips: f })).toEqual({ kind: "zone", zone: "America/Denver" });
    }
    expect(resolveSellerZone({ state: "KS", fips: null })).toEqual({ kind: "hold" });
    expect(resolveSellerZone({ state: "KS", fips: "29095" })).toEqual({ kind: "hold" }); // not a Kansas county
  });

  it("Arizona: Phoenix, except the Navajo Nation counties and unknown county", () => {
    expect(resolveSellerZone({ state: "AZ", fips: "04013" })).toEqual({ kind: "zone", zone: "America/Phoenix" }); // Maricopa
    for (const f of ["04001", "04005", "04017"]) expect(resolveSellerZone({ state: "AZ", fips: f })).toEqual({ kind: "hold" });
    expect(resolveSellerZone({ state: "AZ", fips: null })).toEqual({ kind: "hold" });
  });

  it("every other split-zone state holds, even with a county", () => {
    for (const state of ["TX", "FL", "NE", "SD", "ND", "ID", "OR", "KY", "TN", "IN", "MI", "AK"]) {
      expect(resolveSellerZone({ state, fips: "48141" })).toEqual({ kind: "hold" });
    }
  });

  it("blank or unmapped state holds", () => {
    for (const state of [null, "", "  ", "California", "ZZ"]) expect(resolveSellerZone({ state, fips: null })).toEqual({ kind: "hold" });
  });
});
