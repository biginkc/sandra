import { describe, expect, it } from "vitest";

import { propstreamPreset } from "./propstream";

const FULL_HEADERS = [
  "Address", "Unit #", "City", "State", "Zip",
  "Phone 1", "Phone 1 Type", "Phone 1 DNC",
  "Phone 2", "Phone 2 Type", "Phone 2 DNC",
  "Phone 3", "Phone 3 Type", "Phone 3 DNC",
  "Phone 4", "Phone 4 Type", "Phone 4 DNC",
  "Phone 5", "Phone 5 Type", "Phone 5 DNC",
  "Email 1", "Email 2", "Email 3", "Email 4",
  "Owner 1 First Name", "Owner 1 Last Name",
  "Owner 2 First Name", "Owner 2 Last Name",
  "Method of Add",
];

function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "Address": "123 Main St",
    "State": "MO",
    "Phone 1": "8165551001",
    "Phone 1 Type": "Mobile",
    "Phone 1 DNC": "",
    "Phone 2": "8165551002",
    "Phone 2 Type": "Mobile",
    "Phone 2 DNC": "",
    "Phone 3": "8165551003",
    "Phone 3 Type": "Landline",
    "Phone 3 DNC": "",
    "Phone 4": "8165551004",
    "Phone 4 Type": "Mobile",
    "Phone 4 DNC": "",
    "Phone 5": "8165551005",
    "Phone 5 Type": "Landline",
    "Phone 5 DNC": "",
    "Email 1": "owner@example.com",
    "Email 2": "",
    "Email 3": "",
    "Email 4": "",
    "Owner 1 First Name": "Jane",
    "Owner 1 Last Name": "Smith",
    "Owner 2 First Name": "",
    "Owner 2 Last Name": "",
    "Method of Add": "",
    ...overrides,
  };
}

describe("propstreamPreset.detect", () => {
  it("returns 1.0 for the full signature", () => {
    const result = propstreamPreset.detect(FULL_HEADERS, []);
    expect(result?.id).toBe("propstream");
    expect(result?.confidence).toBe(1.0);
  });
  it("near-miss headers (3 of 4 signature) → < 0.7", () => {
    const partial = ["Phone 1", "Phone 1 Type", "Phone 1 DNC"];
    const result = propstreamPreset.detect(partial, []);
    expect(result?.confidence ?? 0).toBeLessThan(0.7);
  });
  it("returns null for empty headers", () => {
    expect(propstreamPreset.detect([], [])).toBeNull();
  });
  it("returns null when no signature headers match", () => {
    expect(propstreamPreset.detect(["Address", "City"], [])).toBeNull();
  });
});

describe("propstreamPreset.transform — phone fold", () => {
  it("collapses 5 phones into 3 slots when no DNC", () => {
    const result = propstreamPreset.transform([row()], FULL_HEADERS);
    const r = result.rows[0];
    expect(r.homeowner_phone_1).toBe("8165551001");
    expect(r.homeowner_phone_2).toBe("8165551002");
    expect(r.homeowner_phone_3).toBe("8165551003");
    expect(r.homeowner_do_not_contact).toBeUndefined();
  });
  it("drops DNC slot first; keeps next 3 non-DNC", () => {
    const result = propstreamPreset.transform(
      [row({ "Phone 2 DNC": "Yes" })],
      FULL_HEADERS,
    );
    const r = result.rows[0];
    // Slot 2 dropped; first 3 of {1,3,4,5} = 1,3,4
    expect([r.homeowner_phone_1, r.homeowner_phone_2, r.homeowner_phone_3])
      .toEqual(["8165551001", "8165551003", "8165551004"]);
    expect(r.homeowner_do_not_contact).toBe("true");
  });
  it("all-empty phones → no DNC flag, slots empty", () => {
    const empty = row({
      "Phone 1": "", "Phone 2": "", "Phone 3": "", "Phone 4": "", "Phone 5": "",
    });
    const result = propstreamPreset.transform([empty], FULL_HEADERS);
    const r = result.rows[0];
    expect(r.homeowner_phone_1).toBe("");
    expect(r.homeowner_do_not_contact).toBeUndefined();
  });
  it("removes the source phone columns from output rows", () => {
    const result = propstreamPreset.transform([row()], FULL_HEADERS);
    const r = result.rows[0];
    expect(r["Phone 1"]).toBeUndefined();
    expect(r["Phone 1 Type"]).toBeUndefined();
    expect(r["Phone 1 DNC"]).toBeUndefined();
  });
});

describe("propstreamPreset.transform — owner names + Method of Add", () => {
  it("maps Owner 1 → homeowner_first/last; drops Owner 2 with note when populated", () => {
    const r = propstreamPreset.transform(
      [row({ "Owner 2 First Name": "Bob", "Owner 2 Last Name": "Smith" })],
      FULL_HEADERS,
    );
    expect(r.rows[0].homeowner_first_name).toBe("Jane");
    expect(r.rows[0].homeowner_last_name).toBe("Smith");
    expect(r.rows[0]["Owner 1 First Name"]).toBeUndefined();
    expect(r.rows[0]["Owner 2 First Name"]).toBeUndefined();
    expect(r.stats.notes.some((n) => /Owner 2/.test(n))).toBe(true);
  });
  it("Method of Add 'Manual' → suggestions.tags includes propstream-manual", () => {
    const r = propstreamPreset.transform(
      [row({ "Method of Add": "Manual" })],
      FULL_HEADERS,
    );
    expect(r.suggestions?.tags).toEqual(["propstream-manual"]);
  });
  it("Method of Add empty → no manual tag", () => {
    const r = propstreamPreset.transform([row()], FULL_HEADERS);
    expect(r.suggestions?.tags).toBeUndefined();
  });
});

describe("propstreamPreset.transform — email + suggestions", () => {
  it("collapses Email 1..4 into homeowner_email (first non-empty)", () => {
    const r = propstreamPreset.transform(
      [row({ "Email 1": "", "Email 2": "second@example.com" })],
      FULL_HEADERS,
    );
    expect(r.rows[0].homeowner_email).toBe("second@example.com");
    expect(r.rows[0]["Email 1"]).toBeUndefined();
  });
  it("suggests source: propstream", () => {
    const r = propstreamPreset.transform([row()], FULL_HEADERS);
    expect(r.suggestions?.sourceSuggestion).toBe("propstream");
  });
});
