import { describe, expect, it } from "vitest";

import { isEmailAllowed } from "./allowlist";

describe("isEmailAllowed", () => {
  it("allows BMH Group workspace email addresses", () => {
    expect(isEmailAllowed("Jarrad@BMHGROUPKC.COM")).toBe(true);
  });

  it("rejects the old pre-prod test backdoor email", () => {
    const oldBackdoorEmail = ["claude", "test.com"].join("@");
    expect(isEmailAllowed(oldBackdoorEmail)).toBe(false);
  });

  it("rejects missing and non-BMH email addresses", () => {
    expect(isEmailAllowed(null)).toBe(false);
    expect(isEmailAllowed("person@example.com")).toBe(false);
  });
});
