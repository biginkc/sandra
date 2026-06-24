import { describe, expect, it } from "vitest";

import {
  asLineType,
  isDoNotCallLabel,
  lineTypeFromVendorLabel,
} from "./line-type";

describe("lineTypeFromVendorLabel", () => {
  it("maps mobile/cell/wireless to mobile", () => {
    expect(lineTypeFromVendorLabel("Mobile")).toBe("mobile");
    expect(lineTypeFromVendorLabel("Cell")).toBe("mobile");
    expect(lineTypeFromVendorLabel("Wireless")).toBe("mobile");
  });

  it("maps landline variants to landline", () => {
    expect(lineTypeFromVendorLabel("Landline")).toBe("landline");
    expect(lineTypeFromVendorLabel("Land Line")).toBe("landline");
  });

  it("treats a do-not-call marker as unknown (no usable line type)", () => {
    // The protective signal lives in isDoNotCallLabel; the line type
    // itself is unknown so the number drops under the hard rule.
    expect(lineTypeFromVendorLabel("DO NOT CALL")).toBe("unknown");
  });

  it("falls back to unknown for unrecognized labels", () => {
    expect(lineTypeFromVendorLabel("Satellite")).toBe("unknown");
    expect(lineTypeFromVendorLabel("")).toBe("unknown");
    expect(lineTypeFromVendorLabel(null)).toBe("unknown");
  });
});

describe("isDoNotCallLabel", () => {
  it("recognizes DealMachine's DO NOT CALL spellings", () => {
    expect(isDoNotCallLabel("DO NOT CALL")).toBe(true);
    expect(isDoNotCallLabel("do not call")).toBe(true);
    expect(isDoNotCallLabel("Do_Not_Call")).toBe(true);
    expect(isDoNotCallLabel("  DO  NOT  CALL  ")).toBe(true);
  });

  it("recognizes DNC abbreviations and the Do Not Contact spelling", () => {
    expect(isDoNotCallLabel("DNC")).toBe(true);
    expect(isDoNotCallLabel("dnc")).toBe(true);
    expect(isDoNotCallLabel("Do Not Contact")).toBe(true);
  });

  it("does not flag real line types or empty values", () => {
    expect(isDoNotCallLabel("Mobile")).toBe(false);
    expect(isDoNotCallLabel("Landline")).toBe(false);
    expect(isDoNotCallLabel("Wireless")).toBe(false);
    expect(isDoNotCallLabel("")).toBe(false);
    expect(isDoNotCallLabel(null)).toBe(false);
    expect(isDoNotCallLabel(undefined)).toBe(false);
  });
});

describe("asLineType", () => {
  it("narrows arbitrary strings to the line-type vocabulary", () => {
    expect(asLineType("mobile")).toBe("mobile");
    expect(asLineType("landline")).toBe("landline");
    expect(asLineType("DO NOT CALL")).toBe("unknown");
    expect(asLineType(null)).toBe("unknown");
  });
});
