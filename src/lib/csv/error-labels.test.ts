import { describe, expect, it } from "vitest";

import { ruleLabel, summarizeTopError } from "./error-labels";

describe("ruleLabel", () => {
  it("translates a known rule to a human label", () => {
    expect(ruleLabel("required")).toBe("Missing required field");
    expect(ruleLabel("invalid_phone")).toBe("Invalid phone number");
    expect(ruleLabel("address_full_no_street")).toBe(
      "Address has city/state but no street",
    );
  });

  it("falls back to the raw rule key when unknown", () => {
    expect(ruleLabel("brand_new_rule_we_havent_added_yet")).toBe(
      "brand_new_rule_we_havent_added_yet",
    );
  });
});

describe("summarizeTopError", () => {
  it("returns null when there are no errors", () => {
    expect(summarizeTopError({})).toBeNull();
  });

  it("returns the labelled rule when there is only one bucket", () => {
    expect(summarizeTopError({ required: 873 })).toBe(
      "All errors are: missing required field.",
    );
  });

  it("calls out the dominant rule when it exceeds 80% of errors", () => {
    expect(
      summarizeTopError({ required: 850, invalid_phone: 23 }),
    ).toBe("Most are: missing required field.");
  });

  it("falls back to a count-based summary when no rule dominates", () => {
    expect(
      summarizeTopError({ required: 50, invalid_phone: 50 }),
    ).toBe("Top error: missing required field (50 of 100).");
  });
});
