import { describe, expect, it } from "vitest";

import { isValidEsignEmail } from "./email";

describe("isValidEsignEmail", () => {
  it.each(["seller@example.com", " seller@example.com ", "a@b"])(
    "accepts %j",
    (value) => {
      expect(isValidEsignEmail(value)).toBe(true);
    },
  );

  it.each([
    "",
    "   ",
    "@example.com",
    "seller@",
    "seller@@example.com",
    "seller name@example.com",
    "seller@exa mple.com",
    "seller@example.com other",
  ])("rejects %j", (value) => {
    expect(isValidEsignEmail(value)).toBe(false);
  });
});
