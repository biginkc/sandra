import { describe, expect, it } from "vitest";

import {
  classifyAddressFullFailure,
  normalizeAddress,
  normalizeApn,
  normalizeCountyName,
  normalizeDisplayAddress,
  normalizeName,
  normalizePhone,
  normalizeStateCode,
  normalizeZip,
  parseFullAddress,
  toBoolOrNull,
  toIntOrNull,
  toNumberOrNull,
  toStringOrNull,
} from "./normalize";

describe("normalizeAddress", () => {
  it("collapses suffix variations into one form", () => {
    const a = normalizeAddress("123 Main St");
    const b = normalizeAddress("123 MAIN STREET");
    const c = normalizeAddress("123 main st.");
    const d = normalizeAddress("123 Main Street");
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(c).toBe(d);
    expect(a).toBe("123 main st");
  });

  it("collapses unit designator variations", () => {
    const variants = [
      "123 Main St Apt 4B",
      "123 Main St Unit 4B",
      "123 Main St Suite 4B",
      "123 Main St Ste 4B",
      "123 Main St #4B",
    ].map(normalizeAddress);
    const first = variants[0];
    for (const v of variants) {
      expect(v).toBe(first);
    }
  });

  it("normalizes directional prefixes and suffixes", () => {
    expect(normalizeAddress("123 N Main St")).toBe(
      normalizeAddress("123 north main street"),
    );
    expect(normalizeAddress("456 SE Elm Ave")).toBe(
      normalizeAddress("456 southeast elm avenue"),
    );
  });

  it("handles common street-type variants", () => {
    expect(normalizeAddress("9 Oak Boulevard")).toBe(
      normalizeAddress("9 Oak Blvd"),
    );
    expect(normalizeAddress("10 Pine Parkway")).toBe(
      normalizeAddress("10 Pine Pkwy"),
    );
    expect(normalizeAddress("11 Elm Place")).toBe(
      normalizeAddress("11 Elm Pl"),
    );
    expect(normalizeAddress("12 Ridge Crossing")).toBe(
      normalizeAddress("12 Ridge Xing"),
    );
  });

  it("returns null for null/undefined/empty/whitespace", () => {
    expect(normalizeAddress(null)).toBeNull();
    expect(normalizeAddress(undefined)).toBeNull();
    expect(normalizeAddress("")).toBeNull();
    expect(normalizeAddress("   ")).toBeNull();
  });

  it("strips quotes, commas, periods", () => {
    expect(normalizeAddress('"123 Main St."')).toBe("123 main st");
    expect(normalizeAddress("123 Main St., Apt 4")).toBe("123 main st apt 4");
  });
});

describe("parseFullAddress", () => {
  it("splits a clean USPS-ish string", () => {
    expect(parseFullAddress("123 Main St, Kansas City, MO 64108")).toEqual({
      address: "123 Main St",
      city: "Kansas City",
      state: "MO",
      zip: "64108",
    });
  });

  it("handles ZIP+4", () => {
    expect(
      parseFullAddress("123 Main St, Kansas City, MO 64108-1234"),
    ).toEqual({
      address: "123 Main St",
      city: "Kansas City",
      state: "MO",
      zip: "64108-1234",
    });
  });

  it("handles unit designators in the street portion", () => {
    expect(
      parseFullAddress("123 Main St Apt 4B, Kansas City, MO 64108"),
    ).toEqual({
      address: "123 Main St Apt 4B",
      city: "Kansas City",
      state: "MO",
      zip: "64108",
    });
  });

  it("upper-cases the state code", () => {
    const parsed = parseFullAddress("1 A St, Somewhere, mo 12345");
    expect(parsed?.state).toBe("MO");
  });

  it("tolerates trailing USA / extra whitespace", () => {
    expect(
      parseFullAddress("  123 Main St, Kansas City, MO 64108, USA  "),
    ).toEqual({
      address: "123 Main St",
      city: "Kansas City",
      state: "MO",
      zip: "64108",
    });
  });

  it("returns null when the string is missing commas or ZIP", () => {
    expect(parseFullAddress("123 Main St Kansas City MO 64108")).toBeNull();
    expect(parseFullAddress("123 Main St, Kansas City, MO")).toBeNull();
    expect(parseFullAddress("")).toBeNull();
    expect(parseFullAddress(null)).toBeNull();
    expect(parseFullAddress(undefined)).toBeNull();
  });
});

describe("classifyAddressFullFailure", () => {
  it("classifies empty / null / whitespace as 'empty'", () => {
    expect(classifyAddressFullFailure(null)).toBe("empty");
    expect(classifyAddressFullFailure(undefined)).toBe("empty");
    expect(classifyAddressFullFailure("")).toBe("empty");
    expect(classifyAddressFullFailure("   ")).toBe("empty");
  });

  it("classifies 'City, State ZIP' as 'no_street' (DealMachine skip-trace without street)", () => {
    expect(classifyAddressFullFailure("Weston, Mo 64098")).toBe("no_street");
    expect(classifyAddressFullFailure(", Mo")).toBe("no_street");
    expect(classifyAddressFullFailure("Kansas City MO")).toBe("no_street");
  });

  it("classifies malformed three-part values as 'malformed'", () => {
    // Two commas but doesn't match the regex — e.g. missing ZIP.
    expect(
      classifyAddressFullFailure("123 Main St, Kansas City, Missouri"),
    ).toBe("malformed");
  });
});

describe("normalizePhone", () => {
  it("formats 10-digit US phones as E.164", () => {
    expect(normalizePhone("8165551234")).toBe("+18165551234");
    expect(normalizePhone("(816) 555-1234")).toBe("+18165551234");
    expect(normalizePhone("816-555-1234")).toBe("+18165551234");
    expect(normalizePhone("816.555.1234")).toBe("+18165551234");
  });

  it("strips the leading 1 on 11-digit numbers", () => {
    expect(normalizePhone("18165551234")).toBe("+18165551234");
    expect(normalizePhone("1-816-555-1234")).toBe("+18165551234");
  });

  it("rejects invalid lengths", () => {
    expect(normalizePhone("5551234")).toBeNull(); // 7-digit
    expect(normalizePhone("28165551234")).toBeNull(); // 11-digit, wrong prefix
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it("rejects non-numeric garbage", () => {
    expect(normalizePhone("abc")).toBeNull();
  });
});

describe("normalizeZip", () => {
  it("passes through 5-digit ZIPs", () => {
    expect(normalizeZip("64108")).toBe("64108");
  });

  it("hyphenates 9-digit ZIP+4", () => {
    expect(normalizeZip("641081234")).toBe("64108-1234");
    expect(normalizeZip("64108-1234")).toBe("64108-1234");
  });

  it("zero-pads 4-digit ZIPs that lost a leading zero", () => {
    expect(normalizeZip("1234")).toBe("01234");
  });

  it("returns null for invalid formats", () => {
    expect(normalizeZip("abc")).toBeNull();
    expect(normalizeZip("1")).toBeNull();
    expect(normalizeZip("")).toBeNull();
    expect(normalizeZip(null)).toBeNull();
  });
});

describe("normalizeApn", () => {
  it("strips separators and lowercases", () => {
    expect(normalizeApn("12-34-567")).toBe("1234567");
    expect(normalizeApn("12 34 567")).toBe("1234567");
    expect(normalizeApn("R1234567.01")).toBe("r123456701");
  });

  it("removes known prefixes", () => {
    expect(normalizeApn("APN123-456")).toBe("123456");
    expect(normalizeApn("PIN-12345")).toBe("12345");
    expect(normalizeApn("parcel 987")).toBe("987");
  });

  it("returns null for empty input", () => {
    expect(normalizeApn("")).toBeNull();
    expect(normalizeApn(null)).toBeNull();
    expect(normalizeApn(undefined)).toBeNull();
  });

  it("rejects scientific-notation values from spreadsheet auto-formatting", () => {
    // Excel / Numbers / Google Sheets render long numeric APNs (>15
    // digits) in scientific notation on CSV export. The raw string we
    // see here is "611e+18" or "6.11e18", neither of which is a real
    // assessor parcel number. Returning null lets the row dedup by
    // address instead of by a fake APN that mass-collides.
    expect(normalizeApn("611e+18")).toBeNull();
    expect(normalizeApn("6.11e+18")).toBeNull();
    expect(normalizeApn("611E+18")).toBeNull(); // uppercase E
    expect(normalizeApn("611e18")).toBeNull(); // no sign
    expect(normalizeApn("611e-2")).toBeNull(); // negative exponent
  });

  it("preserves real APNs that happen to contain 'e' or digits", () => {
    // Real APN values with letter prefixes ("PP270000010015") or just
    // digits ("58072010000") shouldn't trip the sci-notation check.
    expect(normalizeApn("PP270000010015")).toBe("pp270000010015");
    expect(normalizeApn("58072010000")).toBe("58072010000");
    expect(normalizeApn("E12345")).toBe("e12345"); // starts with letter
    expect(normalizeApn("123E")).toBe("123e"); // trailing letter, no exponent
  });
});

describe("normalizeStateCode", () => {
  it("accepts 2-letter abbreviations case-insensitive", () => {
    expect(normalizeStateCode("MO")).toBe("MO");
    expect(normalizeStateCode("mo")).toBe("MO");
    expect(normalizeStateCode("OH")).toBe("OH");
  });

  it("accepts full state names case-insensitive", () => {
    expect(normalizeStateCode("Missouri")).toBe("MO");
    expect(normalizeStateCode("missouri")).toBe("MO");
    expect(normalizeStateCode("Ohio")).toBe("OH");
    expect(normalizeStateCode("new york")).toBe("NY");
    expect(normalizeStateCode("District of Columbia")).toBe("DC");
  });

  it("returns null for unknown states", () => {
    expect(normalizeStateCode("Narnia")).toBeNull();
    expect(normalizeStateCode("")).toBeNull();
    expect(normalizeStateCode(null)).toBeNull();
  });

  it("accepts US territories (absentee-owner mailing addresses)", () => {
    expect(normalizeStateCode("PR")).toBe("PR");
    expect(normalizeStateCode("pr")).toBe("PR");
    expect(normalizeStateCode("Puerto Rico")).toBe("PR");
    expect(normalizeStateCode("VI")).toBe("VI");
    expect(normalizeStateCode("Virgin Islands")).toBe("VI");
    expect(normalizeStateCode("US Virgin Islands")).toBe("VI");
    expect(normalizeStateCode("U.S. Virgin Islands")).toBe("VI");
    expect(normalizeStateCode("GU")).toBe("GU");
    expect(normalizeStateCode("Guam")).toBe("GU");
    expect(normalizeStateCode("AS")).toBe("AS");
    expect(normalizeStateCode("American Samoa")).toBe("AS");
    expect(normalizeStateCode("MP")).toBe("MP");
    expect(normalizeStateCode("Northern Mariana Islands")).toBe("MP");
    expect(normalizeStateCode("Northern Marianas")).toBe("MP");
  });
});

describe("normalizeCountyName", () => {
  it("strips County/Parish/Borough suffixes", () => {
    expect(normalizeCountyName("Jackson County")).toBe("jackson");
    expect(normalizeCountyName("Orleans Parish")).toBe("orleans");
    expect(normalizeCountyName("North Slope Borough")).toBe("north slope");
  });

  it("lowercases and trims", () => {
    expect(normalizeCountyName("  JACKSON  ")).toBe("jackson");
  });

  it("returns null for empty", () => {
    expect(normalizeCountyName("")).toBeNull();
    expect(normalizeCountyName(null)).toBeNull();
  });
});

describe("toNumberOrNull", () => {
  it("parses currency and comma-grouped numbers", () => {
    expect(toNumberOrNull("$120,000")).toBe(120000);
    expect(toNumberOrNull("1,234.56")).toBe(1234.56);
    expect(toNumberOrNull("100")).toBe(100);
    expect(toNumberOrNull(100)).toBe(100);
    expect(toNumberOrNull("  99 ")).toBe(99);
  });

  it("returns null for non-numeric", () => {
    expect(toNumberOrNull("abc")).toBeNull();
    expect(toNumberOrNull("")).toBeNull();
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull(undefined)).toBeNull();
  });
});

describe("toIntOrNull", () => {
  it("truncates to integer", () => {
    expect(toIntOrNull("3.99")).toBe(3);
    expect(toIntOrNull("1952")).toBe(1952);
  });

  it("returns null for garbage", () => {
    expect(toIntOrNull("abc")).toBeNull();
  });
});

describe("toBoolOrNull", () => {
  it("accepts truthy strings", () => {
    for (const v of ["true", "TRUE", "t", "yes", "Y", "1"]) {
      expect(toBoolOrNull(v)).toBe(true);
    }
  });

  it("accepts falsy strings", () => {
    for (const v of ["false", "FALSE", "f", "no", "N", "0"]) {
      expect(toBoolOrNull(v)).toBe(false);
    }
  });

  it("passes through actual booleans", () => {
    expect(toBoolOrNull(true)).toBe(true);
    expect(toBoolOrNull(false)).toBe(false);
  });

  it("returns null for ambiguous input", () => {
    expect(toBoolOrNull("maybe")).toBeNull();
    expect(toBoolOrNull("")).toBeNull();
    expect(toBoolOrNull(null)).toBeNull();
  });
});

describe("toStringOrNull", () => {
  it("trims and returns non-empty strings", () => {
    expect(toStringOrNull("hello")).toBe("hello");
    expect(toStringOrNull("  trim  ")).toBe("trim");
  });

  it("returns null for empty/whitespace/null", () => {
    expect(toStringOrNull("")).toBeNull();
    expect(toStringOrNull("   ")).toBeNull();
    expect(toStringOrNull(null)).toBeNull();
  });
});

describe("normalizeDisplayAddress", () => {
  it("title-cases words and uppercases 2-letter tokens", () => {
    expect(normalizeDisplayAddress("1307 NW DEER RUN TRL, BLUE SPRINGS, MO 64015")).toBe(
      "1307 NW Deer Run Trl, Blue Springs, MO 64015",
    );
  });

  it("uppercases state abbreviations", () => {
    expect(normalizeDisplayAddress("KANSAS CITY, MO")).toBe("Kansas City, MO");
    expect(normalizeDisplayAddress("DAYTON, OH")).toBe("Dayton, OH");
  });

  it("uppercases directionals", () => {
    expect(normalizeDisplayAddress("123 NW MAIN ST")).toBe("123 NW Main ST");
    expect(normalizeDisplayAddress("456 SE ELM AVE")).toBe("456 SE Elm Ave");
  });

  it("leaves longer words title-cased", () => {
    expect(normalizeDisplayAddress("BLUE SPRINGS")).toBe("Blue Springs");
    expect(normalizeDisplayAddress("DEER RUN TRL")).toBe("Deer Run Trl");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeDisplayAddress(null)).toBeNull();
    expect(normalizeDisplayAddress(undefined)).toBeNull();
    expect(normalizeDisplayAddress("")).toBeNull();
  });
});

describe("normalizeName", () => {
  it("title-cases all-caps names", () => {
    expect(normalizeName("JOHN")).toBe("John");
    expect(normalizeName("MARY JO")).toBe("Mary Jo");
    expect(normalizeName("DOE")).toBe("Doe");
  });

  it("title-cases lowercase names", () => {
    expect(normalizeName("john")).toBe("John");
    expect(normalizeName("mary jo")).toBe("Mary Jo");
  });

  it("leaves already-correct names unchanged", () => {
    expect(normalizeName("John")).toBe("John");
    expect(normalizeName("Mary Jo")).toBe("Mary Jo");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeName("  JOHN  ")).toBe("John");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeName(null)).toBeNull();
    expect(normalizeName(undefined)).toBeNull();
    expect(normalizeName("")).toBeNull();
    expect(normalizeName("   ")).toBeNull();
  });
});
