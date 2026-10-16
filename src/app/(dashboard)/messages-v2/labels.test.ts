import { describe, expect, it } from "vitest";

import { formatRunLabel, redactPhone } from "./labels";

describe("redactPhone", () => {
  it("keeps only the last four digits", () => {
    expect(redactPhone("+18165550142")).toBe("···0142");
    expect(redactPhone("(816) 555-0142")).toBe("···0142");
  });
  it("returns null when there are not enough digits", () => {
    expect(redactPhone(null)).toBeNull();
    expect(redactPhone("12")).toBeNull();
  });
});

describe("formatRunLabel", () => {
  it("uses first name and address for known contacts", () => {
    expect(
      formatRunLabel({
        firstName: "Dana",
        address: "12 Elm St",
        city: "Kansas City",
        fromAddress: "+18165550142",
      }),
    ).toEqual({ name: "Dana", address: "12 Elm St, Kansas City" });
  });
  it("redacts the phone for unknown senders and never shows the full number", () => {
    const label = formatRunLabel({
      firstName: null,
      address: null,
      city: null,
      fromAddress: "+18165550142",
    });
    expect(label.name).toBe("Unknown ···0142");
    expect(label.name).not.toContain("816");
    expect(label.address).toBeNull();
  });
  it("falls back to a generic name with no phone", () => {
    expect(
      formatRunLabel({
        firstName: " ",
        address: null,
        city: null,
        fromAddress: null,
      }).name,
    ).toBe("Unknown sender");
  });
});
