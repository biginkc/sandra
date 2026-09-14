import { describe, expect, it } from "vitest";
import { canaryCookieValue, validCanaryCookie } from "./preview-canary-access";

describe("preview canary cookie", () => {
  it("accepts only a correctly signed value and never exposes the secret itself", () => {
    const secret = "owned-canary-secret";
    const value = canaryCookieValue(secret);
    expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(value).not.toContain(secret);
    expect(validCanaryCookie(value, secret)).toBe(true);
    expect(validCanaryCookie(value, "different-secret")).toBe(false);
    expect(validCanaryCookie("invalid", secret)).toBe(false);
  });
});
