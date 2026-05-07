import { describe, expect, it } from "vitest";

import { reisiftPreset } from "./reisift";

const HEADERS = [
  "contact_id", "lead_id", "associated_property_id",
  "associated_property_address_full",
  "associated_property_address_line_1",
  "associated_property_address_city",
  "associated_property_address_state",
  "associated_property_address_zipcode",
  "first_name", "last_name",
  "phone_1", "phone_1_carrier", "phone_1_type",
  "phone_2", "phone_2_carrier",
  "phone_3", "phone_3_carrier",
];

function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    contact_id: "c1",
    lead_id: "l1",
    associated_property_id: "p1",
    associated_property_address_full: "123 Main St, Kansas City, MO 64108",
    associated_property_address_line_1: "123 Main St",
    associated_property_address_city: "Kansas City",
    associated_property_address_state: "MO",
    associated_property_address_zipcode: "64108",
    first_name: "JANE",
    last_name: "SMITH",
    phone_1: "8165551001",
    phone_1_carrier: "Verizon",
    phone_1_type: "Mobile",
    phone_2: "",
    phone_2_carrier: "",
    phone_3: "",
    phone_3_carrier: "",
    ...overrides,
  };
}

describe("reisiftPreset.detect", () => {
  it("returns 1.0 for the full signature", () => {
    const r = reisiftPreset.detect(HEADERS, []);
    expect(r?.id).toBe("reisift");
    expect(r?.confidence).toBe(1.0);
  });
  it("near-miss (2 of 3 sig headers) → < 0.7", () => {
    const r = reisiftPreset.detect(["contact_id", "phone_1"], []);
    expect(r?.confidence ?? 0).toBeLessThan(0.7);
  });
  it("empty headers → null", () => {
    expect(reisiftPreset.detect([], [])).toBeNull();
  });
});

describe("reisiftPreset.transform", () => {
  it("decodes 'DNC Excluded' in phone_1 → null + DNC flag", () => {
    const r = reisiftPreset.transform([row({ phone_1: "DNC Excluded" })], HEADERS);
    expect(r.rows[0].homeowner_phone_1).toBe("");
    expect(r.rows[0].homeowner_do_not_contact).toBe("true");
  });
  it("complete split + complete address_full → drops address_full", () => {
    const r = reisiftPreset.transform([row()], HEADERS);
    expect(r.rows[0].associated_property_address_full).toBeUndefined();
  });
  it("incomplete split + address_full present → keeps address_full", () => {
    const r = reisiftPreset.transform(
      [row({ associated_property_address_state: "" })],
      HEADERS,
    );
    expect(r.rows[0].associated_property_address_full).toBe("123 Main St, Kansas City, MO 64108");
  });
  it("title-cases ALL CAPS names through normalizeName", () => {
    const r = reisiftPreset.transform([row()], HEADERS);
    expect(r.rows[0].first_name).toBe("Jane");
    expect(r.rows[0].last_name).toBe("Smith");
  });
  it("drops phone sub-attribute columns from output rows", () => {
    const r = reisiftPreset.transform([row()], HEADERS);
    expect(r.rows[0].phone_1_carrier).toBeUndefined();
    expect(r.rows[0].phone_1_type).toBeUndefined();
    expect(r.stats.columnsRemoved).toContain("phone_1_carrier");
  });
  it("suggests source: reisift", () => {
    const r = reisiftPreset.transform([row()], HEADERS);
    expect(r.suggestions?.sourceSuggestion).toBe("reisift");
  });
});
