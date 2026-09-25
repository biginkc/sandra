import { describe, expect, it } from "vitest";

import { sourceUnknownPhonesForRecovery } from "./recover-assigns-phones";

describe("sourceUnknownPhonesForRecovery", () => {
  it("returns only normalized unknown-type slots", () => {
    expect(
      sourceUnknownPhonesForRecovery({
        phones: [
          { value: "816-555-0100", type: "unknown" },
          { value: "816-555-0101", type: "mobile" },
          { value: "816-555-0102", type: "landline" },
          { value: "not a phone", type: "unknown" },
        ],
      }),
    ).toEqual(["+18165550100"]);
  });

  it("does not infer a type or read unrelated source attributes", () => {
    expect(
      sourceUnknownPhonesForRecovery({
        dnc: "Y",
        litigator: "Y",
        phones: [{ value: "8165550103", type: "wireless" }],
      }),
    ).toEqual([]);
  });

  it("tolerates malformed source attributes", () => {
    expect(sourceUnknownPhonesForRecovery(null)).toEqual([]);
    expect(sourceUnknownPhonesForRecovery({ phones: "nope" })).toEqual([]);
    expect(sourceUnknownPhonesForRecovery({ phones: [null, "nope"] })).toEqual([]);
  });
});
