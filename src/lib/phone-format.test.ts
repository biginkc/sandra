import { describe, expect, it } from "vitest";

import { formatPhoneDisplay, toPhoneE164 } from "./phone-format";

describe("formatPhoneDisplay", () => {
  it.each([
    ["+19135484567", "(913) 548-4567"],
    ["19135484567", "(913) 548-4567"],
    ["9135484567", "(913) 548-4567"],
    ["+1 (913) 548-4567", "(913) 548-4567"],
    ["(913) 548-4567", "(913) 548-4567"],
  ])("displays %s as %s", (raw, expected) => {
    expect(formatPhoneDisplay(raw)).toBe(expected);
  });

  it("leaves incomplete, international, and non-phone values intact", () => {
    expect(formatPhoneDisplay("555-0100")).toBe("555-0100");
    expect(formatPhoneDisplay("+442071838750")).toBe("+442071838750");
    expect(formatPhoneDisplay("Office 9135484567")).toBe("Office 9135484567");
    expect(formatPhoneDisplay(null)).toBeNull();
  });

  it("does not change the transport representation", () => {
    const raw = "+19135484567";
    expect(formatPhoneDisplay(raw)).toBe("(913) 548-4567");
    expect(toPhoneE164(raw)).toBe(raw);
  });
});
