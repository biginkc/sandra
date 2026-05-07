import { describe, expect, it } from "vitest";

import { zillowUrl } from "./zillow-url";

describe("zillowUrl", () => {
  it("builds a redirect URL from full address parts", () => {
    expect(
      zillowUrl({
        address: "5722 Troost Ave",
        city: "Kansas City",
        state: "MO",
        zip: "64110",
      }),
    ).toBe("https://www.zillow.com/homes/5722-Troost-Ave-Kansas-City-MO-64110_rb/");
  });

  it("works without a zip", () => {
    expect(
      zillowUrl({
        address: "1 Main St",
        city: "Lincoln",
        state: "NE",
      }),
    ).toBe("https://www.zillow.com/homes/1-Main-St-Lincoln-NE_rb/");
  });

  it("works with only the street address", () => {
    expect(zillowUrl({ address: "123 Oak Ln" })).toBe(
      "https://www.zillow.com/homes/123-Oak-Ln_rb/",
    );
  });

  it("strips punctuation from inside parts", () => {
    expect(
      zillowUrl({
        address: "12-34 N. Main St., Apt #5",
        city: "St. Louis",
        state: "MO",
      }),
    ).toBe(
      "https://www.zillow.com/homes/12-34-N-Main-St-Apt-5-St-Louis-MO_rb/",
    );
  });

  it("collapses repeated whitespace into single hyphens", () => {
    expect(
      zillowUrl({
        address: "100   Park   Avenue",
        city: "New  York",
        state: "NY",
      }),
    ).toBe("https://www.zillow.com/homes/100-Park-Avenue-New-York-NY_rb/");
  });

  it("returns null when address is missing or empty", () => {
    expect(zillowUrl({ address: null })).toBeNull();
    expect(zillowUrl({ address: undefined })).toBeNull();
    expect(zillowUrl({ address: "" })).toBeNull();
    expect(zillowUrl({ address: "   " })).toBeNull();
  });

  it("returns null when address slugifies to nothing", () => {
    expect(zillowUrl({ address: "!!!" })).toBeNull();
  });

  it("preserves digits and lowercase/uppercase mix as-is", () => {
    expect(
      zillowUrl({ address: "9709 E 80TH Ter", city: "Raytown", state: "MO" }),
    ).toBe(
      "https://www.zillow.com/homes/9709-E-80TH-Ter-Raytown-MO_rb/",
    );
  });
});
