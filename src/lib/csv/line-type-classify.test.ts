import { describe, expect, it } from "vitest";

import type { PhoneLineType } from "@/lib/messaging/line-type";

import {
  applyLineTypes,
  collectUnlabeledPhones,
  summarizeClassification,
} from "./line-type-classify";
import { validateRow, type Mapping } from "./validate";

const mapping: Mapping = {
  address: "Address",
  state: "State",
  homeowner_phone_1: "Phone 1",
  homeowner_phone_1_type: "Phone 1 Type",
  homeowner_phone_2: "Phone 2",
  // Phone 2 has no type column mapped — classification must invent one.
};

const rows = [
  {
    Address: "123 Main St",
    State: "MO",
    "Phone 1": "816-555-0001",
    "Phone 1 Type": "mobile", // already labeled — not collected
    "Phone 2": "816-555-0002", // unlabeled
  },
  {
    Address: "456 Elm Ave",
    State: "KS",
    "Phone 1": "913-555-0003", // type cell empty → unlabeled
    "Phone 1 Type": "",
    "Phone 2": "816-555-0002", // duplicate of row 0's number → distinct set
  },
  {
    // Invalid row (no state) — its phones never reach ingest, so they
    // must not be collected for a paid lookup.
    Address: "789 Oak Blvd",
    "Phone 1": "913-555-0099",
  },
];

describe("collectUnlabeledPhones", () => {
  it("collects distinct E.164 numbers whose slot type is unknown, valid rows only", () => {
    const numbers = collectUnlabeledPhones(rows, mapping);
    expect(numbers.sort()).toEqual(["+18165550002", "+19135550003"]);
  });
});

describe("applyLineTypes", () => {
  it("writes classified types back so validateRow resolves them at ingest", () => {
    const classified = new Map<string, PhoneLineType>([
      ["+18165550002", "mobile"],
      ["+19135550003", "landline"],
    ]);
    const applied = applyLineTypes(rows, mapping, classified);

    // Row 0: phone_2 had no mapped type column → synthetic header added
    // to the mapping and the cell written.
    const v0 = validateRow(applied.rows[0], applied.mapping, 0);
    expect(v0.normalized.homeowner_phone_2_type).toBe("mobile");
    // Row 0 phone_1 was already labeled — untouched.
    expect(v0.normalized.homeowner_phone_1_type).toBe("mobile");

    // Row 1: phone_1's mapped-but-empty type cell gets the lookup result.
    const v1 = validateRow(applied.rows[1], applied.mapping, 1);
    expect(v1.normalized.homeowner_phone_1_type).toBe("landline");
    expect(v1.normalized.homeowner_phone_2_type).toBe("mobile");

    // 3 slots labeled: row0 phone_2, row1 phone_1, row1 phone_2.
    expect(applied.labeledSlots).toBe(3);

    // Inputs not mutated.
    expect(rows[0]["Phone 1 Type"]).toBe("mobile");
    expect(mapping.homeowner_phone_2_type).toBeUndefined();
  });

  it("leaves still-unknown numbers untouched so ingest drops and counts them", () => {
    const classified = new Map<string, PhoneLineType>([
      ["+18165550002", "unknown"],
    ]);
    const applied = applyLineTypes(rows, mapping, classified);
    const v0 = validateRow(applied.rows[0], applied.mapping, 0);
    expect(v0.normalized.homeowner_phone_2_type ?? null).toBeNull();
    expect(applied.labeledSlots).toBe(0);
  });
});

describe("summarizeClassification", () => {
  it("counts per-type and rounds the cost to cents", () => {
    const classified = new Map<string, PhoneLineType>([
      ["+18165550001", "mobile"],
      ["+18165550002", "mobile"],
      ["+18165550003", "landline"],
      ["+18165550004", "unknown"],
    ]);
    expect(summarizeClassification(classified, 0.003)).toEqual({
      classifiedMobile: 2,
      classifiedLandline: 1,
      stillUnknown: 1,
      estimatedCostUsd: 0.01,
    });
  });
});
