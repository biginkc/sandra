import { describe, expect, it } from "vitest";
import { canaryCookieValue, validCanaryCookie } from "./preview-canary-access";

describe("preview canary cookie", () => {
  it("accepts only a correctly signed value and never exposes the secret itself", () => {
    const secret = "owned-canary-secret";
    const now = 1_800_000_000_000;
    const value = canaryCookieValue(secret, now);
    expect(value).toMatch(/^\d{10}\.[a-f0-9]{64}$/);
    expect(value).not.toContain(secret);
    expect(validCanaryCookie(value, secret, now)).toBe(true);
    expect(validCanaryCookie(value, secret, now + 300_000)).toBe(false);
    expect(validCanaryCookie(value, "different-secret", now)).toBe(false);
    expect(validCanaryCookie("invalid", secret, now)).toBe(false);
  });
});
