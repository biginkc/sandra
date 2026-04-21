import { describe, expect, it } from "vitest";

import { parseSmartyResponse } from "./smartystreets";

const baseCandidate = {
  input_index: 0,
  candidate_index: 0,
  delivery_line_1: "1600 Amphitheatre Pkwy",
  last_line: "Mountain View CA 94043-1351",
  components: {
    primary_number: "1600",
    street_name: "Amphitheatre",
    street_suffix: "Pkwy",
    city_name: "Mountain View",
    state_abbreviation: "CA",
    zipcode: "94043",
    plus4_code: "1351",
  },
  metadata: {
    latitude: 37.422,
    longitude: -122.084,
    vacant: "N" as const,
  },
  analysis: { dpv_match_code: "Y" as const },
};

describe("parseSmartyResponse", () => {
  it("returns invalid status for empty results", () => {
    const result = parseSmartyResponse([]);
    expect(result.cassStatus).toBe("invalid");
    expect(result.standardized).toBe("");
  });

  it("treats DPV match codes Y/S/D as verified", () => {
    for (const code of ["Y", "S", "D"] as const) {
      const result = parseSmartyResponse([
        { ...baseCandidate, analysis: { dpv_match_code: code } },
      ]);
      expect(result.cassStatus).toBe("verified");
    }
  });

  it("treats DPV match code N as invalid", () => {
    const result = parseSmartyResponse([
      { ...baseCandidate, analysis: { dpv_match_code: "N" } },
    ]);
    expect(result.cassStatus).toBe("invalid");
  });

  it("flags multiple candidates as ambiguous regardless of DPV", () => {
    const result = parseSmartyResponse([
      baseCandidate,
      { ...baseCandidate, candidate_index: 1 },
    ]);
    expect(result.cassStatus).toBe("ambiguous");
  });

  it("falls back to unverified when DPV code is missing or unknown", () => {
    const result = parseSmartyResponse([
      { ...baseCandidate, analysis: {} },
    ]);
    expect(result.cassStatus).toBe("unverified");
  });

  it("joins delivery lines + last_line into the standardized form", () => {
    const result = parseSmartyResponse([
      {
        ...baseCandidate,
        delivery_line_2: "Suite 500",
      },
    ]);
    expect(result.standardized).toBe(
      "1600 Amphitheatre Pkwy, Suite 500, Mountain View CA 94043-1351",
    );
  });

  it("extracts components and geolocation when present", () => {
    const result = parseSmartyResponse([baseCandidate]);
    expect(result.components.primaryNumber).toBe("1600");
    expect(result.components.streetSuffix).toBe("Pkwy");
    expect(result.components.zip5).toBe("94043");
    expect(result.components.plus4).toBe("1351");
    expect(result.lat).toBe(37.422);
    expect(result.lon).toBe(-122.084);
  });

  it("normalizes the vacant flag (Y → true, N → false, missing → null)", () => {
    expect(parseSmartyResponse([baseCandidate]).isVacant).toBe(false);
    expect(
      parseSmartyResponse([
        { ...baseCandidate, metadata: { vacant: "Y" } },
      ]).isVacant,
    ).toBe(true);
    expect(
      parseSmartyResponse([{ ...baseCandidate, metadata: {} }]).isVacant,
    ).toBeNull();
  });

  it("preserves the raw response under .raw for audit", () => {
    const candidates = [baseCandidate];
    const result = parseSmartyResponse(candidates);
    expect(result.raw).toBe(candidates);
  });
});
