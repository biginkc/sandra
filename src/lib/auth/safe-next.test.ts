import { describe, expect, it } from "vitest";

import { sanitizeNextPath } from "./safe-next";

describe("sanitizeNextPath", () => {
  it("accepts plain same-site paths", () => {
    expect(sanitizeNextPath("/leads/123", "/dashboard")).toBe("/leads/123");
    expect(sanitizeNextPath("/properties?view=map", "/dashboard")).toBe(
      "/properties?view=map",
    );
    expect(sanitizeNextPath("/dashboard", "")).toBe("/dashboard");
  });

  it("falls back for empty / non-string input", () => {
    expect(sanitizeNextPath("", "/dashboard")).toBe("/dashboard");
    expect(sanitizeNextPath(null, "/dashboard")).toBe("/dashboard");
    expect(sanitizeNextPath(undefined, "/dashboard")).toBe("/dashboard");
    expect(sanitizeNextPath(42, "/dashboard")).toBe("/dashboard");
    expect(sanitizeNextPath("", "")).toBe("");
  });

  it("rejects absolute URLs and non-path strings", () => {
    expect(sanitizeNextPath("https://evil.com/x", "/dashboard")).toBe(
      "/dashboard",
    );
    expect(sanitizeNextPath("javascript:alert(1)", "/dashboard")).toBe(
      "/dashboard",
    );
    expect(sanitizeNextPath("leads/123", "/dashboard")).toBe("/dashboard");
  });

  it("rejects scheme-relative forms", () => {
    expect(sanitizeNextPath("//evil.com", "/dashboard")).toBe("/dashboard");
    expect(sanitizeNextPath("//evil.com/path", "/dashboard")).toBe(
      "/dashboard",
    );
  });

  it("rejects backslash tricks (URL parser treats \\ as /)", () => {
    // `next=%2F%5Cevil.example` decodes to `/\evil.example`, which the
    // WHATWG URL parser resolves to https://evil.example/ — off-site.
    expect(sanitizeNextPath("/\\evil.example", "/dashboard")).toBe(
      "/dashboard",
    );
    expect(sanitizeNextPath("\\/evil.example", "/dashboard")).toBe(
      "/dashboard",
    );
    expect(sanitizeNextPath("/\\/evil.example", "/dashboard")).toBe(
      "/dashboard",
    );
    expect(sanitizeNextPath("/leads\\..\\x", "/dashboard")).toBe("/dashboard");
  });

  it("rejects control characters", () => {
    expect(sanitizeNextPath("/leads\r\nSet-Cookie: x=1", "/dashboard")).toBe(
      "/dashboard",
    );
    expect(sanitizeNextPath("/lea\tds", "/dashboard")).toBe("/dashboard");
    expect(sanitizeNextPath("/\u0000leads", "/dashboard")).toBe("/dashboard");
    expect(sanitizeNextPath("/leads\u007f", "/dashboard")).toBe("/dashboard");
  });

  it("still rejects percent-encoded forms that don't decode to a path", () => {
    // Raw (undecoded) query value — doesn't start with "/", so fallback.
    expect(sanitizeNextPath("%2F%5Cevil.example", "/dashboard")).toBe(
      "/dashboard",
    );
  });

  it("rejects /login paths (would loop the login UI)", () => {
    expect(sanitizeNextPath("/login", "/dashboard")).toBe("/dashboard");
    expect(sanitizeNextPath("/login?error=sso", "/dashboard")).toBe(
      "/dashboard",
    );
  });

  it("keeps anything that resolves off the canonical origin out", () => {
    // Belt-and-suspenders: even if a bypass slipped past the char checks,
    // the origin comparison must hold for accepted values.
    const accepted = sanitizeNextPath("/leads/5?x=1#top", "/dashboard");
    expect(new URL(accepted, "https://sandra.invalid").origin).toBe(
      "https://sandra.invalid",
    );
  });
});
