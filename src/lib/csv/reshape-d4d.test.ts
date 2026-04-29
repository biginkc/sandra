import { describe, expect, it } from "vitest";

import { reshapeAddressFull, reshapeRows } from "./reshape-d4d";

describe("reshapeAddressFull", () => {
  it("splits a canonical D4D row using the per-field components", () => {
    const result = reshapeAddressFull(
      "807 TRIPLE LODE DR ANGELS CAMP CA 95222",
      "ANGELS CAMP",
      "CA",
      "95222",
    );
    expect(result.status).toBe("reshaped");
    expect(result.value).toBe("807 TRIPLE LODE DR, ANGELS CAMP, CA 95222");
  });

  it("passes through values that are already comma-delimited (idempotent)", () => {
    const result = reshapeAddressFull(
      "807 TRIPLE LODE DR, ANGELS CAMP, CA 95222",
      "ANGELS CAMP",
      "CA",
      "95222",
    );
    expect(result.status).toBe("already_comma");
    expect(result.value).toBe("807 TRIPLE LODE DR, ANGELS CAMP, CA 95222");
  });

  it("preserves an empty Address Full cell", () => {
    const result = reshapeAddressFull("", "ANGELS CAMP", "CA", "95222");
    expect(result.status).toBe("empty");
    expect(result.value).toBe("");
  });

  it("preserves null/undefined Address Full cells", () => {
    expect(reshapeAddressFull(null, "X", "CA", "95222").status).toBe("empty");
    expect(reshapeAddressFull(undefined, "X", "CA", "95222").status).toBe(
      "empty",
    );
  });

  it("preserves ZIP+4 in the output", () => {
    const result = reshapeAddressFull(
      "807 TRIPLE LODE DR ANGELS CAMP CA 95222-1234",
      "ANGELS CAMP",
      "CA",
      "95222-1234",
    );
    expect(result.status).toBe("reshaped");
    expect(result.value).toBe(
      "807 TRIPLE LODE DR, ANGELS CAMP, CA 95222-1234",
    );
  });

  it("handles addresses without a street suffix (HIGHWAY 12)", () => {
    const result = reshapeAddressFull(
      "10000 E HIGHWAY 12 LODI CA 95240",
      "LODI",
      "CA",
      "95240",
    );
    expect(result.status).toBe("reshaped");
    expect(result.value).toBe("10000 E HIGHWAY 12, LODI, CA 95240");
  });

  it("handles two-word cities (KANSAS CITY)", () => {
    expect(
      reshapeAddressFull(
        "1234 MAIN ST KANSAS CITY MO 64108",
        "KANSAS CITY",
        "MO",
        "64108",
      ).value,
    ).toBe("1234 MAIN ST, KANSAS CITY, MO 64108");
  });

  it("handles unit designators in the street portion (STE 352)", () => {
    const result = reshapeAddressFull(
      "39899 BALENTINE DR STE 352 NEWARK CA 94560",
      "NEWARK",
      "CA",
      "94560",
    );
    expect(result.status).toBe("reshaped");
    expect(result.value).toBe("39899 BALENTINE DR STE 352, NEWARK, CA 94560");
  });

  it("matches case-insensitively against the per-field components", () => {
    const result = reshapeAddressFull(
      "807 triple lode dr angels camp ca 95222",
      "Angels Camp",
      "CA",
      "95222",
    );
    expect(result.status).toBe("reshaped");
    expect(result.value).toBe("807 triple lode dr, Angels Camp, CA 95222");
  });

  it("leaves the row alone when per-field components are missing", () => {
    const result = reshapeAddressFull(
      "807 TRIPLE LODE DR ANGELS CAMP CA 95222",
      "",
      "",
      "",
    );
    expect(result.status).toBe("no_components");
    expect(result.value).toBe("807 TRIPLE LODE DR ANGELS CAMP CA 95222");
  });

  it("leaves the row alone when components don't match the end of Address Full", () => {
    // City says "MIAMI" but Address Full ends with "ANGELS CAMP" — bad data;
    // don't guess, let the validator flag it.
    const result = reshapeAddressFull(
      "807 TRIPLE LODE DR ANGELS CAMP CA 95222",
      "MIAMI",
      "FL",
      "33101",
    );
    expect(result.status).toBe("no_components");
    expect(result.value).toBe("807 TRIPLE LODE DR ANGELS CAMP CA 95222");
  });

  it("handles internal whitespace variation gracefully", () => {
    const result = reshapeAddressFull(
      "807 TRIPLE LODE DR  ANGELS CAMP  CA  95222",
      "ANGELS CAMP",
      "CA",
      "95222",
    );
    expect(result.status).toBe("reshaped");
    expect(result.value).toBe("807 TRIPLE LODE DR, ANGELS CAMP, CA 95222");
  });
});

describe("reshapeRows", () => {
  it("reshapes only the Address Full column, preserving every other field", () => {
    const rows = [
      {
        "INPUT: First Name": "Alice",
        "PROP: Address Full": "807 TRIPLE LODE DR ANGELS CAMP CA 95222",
        "PROP: City": "ANGELS CAMP",
        "PROP: State": "CA",
        "PROP: Zip": "95222",
        "PH: Phone1": "5105551234",
      },
    ];

    const { rows: out, stats } = reshapeRows(
      rows,
      "PROP: Address Full",
      "PROP: City",
      "PROP: State",
      "PROP: Zip",
    );

    expect(stats.rowsReshaped).toBe(1);
    expect(out[0]["PROP: Address Full"]).toBe(
      "807 TRIPLE LODE DR, ANGELS CAMP, CA 95222",
    );
    expect(out[0]["INPUT: First Name"]).toBe("Alice");
    expect(out[0]["PH: Phone1"]).toBe("5105551234");
    expect(out[0]["PROP: City"]).toBe("ANGELS CAMP");
  });

  it("counts all four status buckets accurately", () => {
    const rows = [
      {
        "PROP: Address Full": "1 A ST X CA 90001",
        "PROP: City": "X",
        "PROP: State": "CA",
        "PROP: Zip": "90001",
      },
      {
        "PROP: Address Full": "1 A ST, X, CA 90001",
        "PROP: City": "X",
        "PROP: State": "CA",
        "PROP: Zip": "90001",
      },
      {
        "PROP: Address Full": "",
        "PROP: City": "X",
        "PROP: State": "CA",
        "PROP: Zip": "90001",
      },
      {
        "PROP: Address Full": "1 A ST X CA 90001",
        "PROP: City": "",
        "PROP: State": "CA",
        "PROP: Zip": "90001",
      },
    ];

    const { stats } = reshapeRows(
      rows,
      "PROP: Address Full",
      "PROP: City",
      "PROP: State",
      "PROP: Zip",
    );

    expect(stats).toEqual({
      rowsTotal: 4,
      rowsReshaped: 1,
      rowsAlreadyComma: 1,
      rowsSkippedEmpty: 1,
      rowsSkippedNoComponents: 1,
    });
  });
});
