import { describe, expect, it } from "vitest";

import { parseHugoUrl } from "./hugo-url";

describe("parseHugoUrl", () => {
  it("accepts an HTTPS Hugo URL in production", () => {
    expect(
      parseHugoUrl("https://identity.example.test/team", "production"),
    ).toBe("https://identity.example.test/team");
  });

  it.each([undefined, "", "not a URL", "ftp://identity.example.test"])(
    "rejects missing or malformed configuration: %s",
    (configured) => {
      expect(parseHugoUrl(configured, "production")).toBeNull();
    },
  );

  it("rejects an insecure remote Hugo URL in production", () => {
    expect(
      parseHugoUrl("http://identity.example.test/team", "production"),
    ).toBeNull();
  });

  it.each([
    "http://localhost:3001/team",
    "http://127.0.0.1:3001/team",
    "http://[::1]:3001/team",
  ])("allows loopback HTTP outside production: %s", (configured) => {
    expect(parseHugoUrl(configured, "development")).toBe(configured);
  });

  it("rejects remote HTTP outside production", () => {
    expect(
      parseHugoUrl("http://identity.example.test/team", "development"),
    ).toBeNull();
  });
});
