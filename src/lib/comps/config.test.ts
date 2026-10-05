import { describe, expect, it } from "vitest";

import { ConfigurationError } from "@/lib/errors/classes";

import { getCompProvider } from "./config";

describe("getCompProvider (seam S2)", () => {
  it("unset or off → null (feature off)", () => {
    expect(getCompProvider({})).toBeNull();
    expect(getCompProvider({ COMPS_PROVIDER: "off" })).toBeNull();
    expect(getCompProvider({ COMPS_PROVIDER: " OFF " })).toBeNull();
  });
  it("fixture outside production → fixture provider", () => {
    expect(getCompProvider({ COMPS_PROVIDER: "fixture", VERCEL_ENV: "preview" })?.name).toBe("fixture");
    expect(getCompProvider({ COMPS_PROVIDER: "fixture" })?.name).toBe("fixture");
  });
  it("fixture in production is refused (never show invented numbers)", () => {
    expect(() => getCompProvider({ COMPS_PROVIDER: "fixture", VERCEL_ENV: "production" })).toThrow(ConfigurationError);
  });
  it("attom needs a key; unknown name throws", () => {
    expect(() => getCompProvider({ COMPS_PROVIDER: "attom" })).toThrow(ConfigurationError);
    expect(getCompProvider({ COMPS_PROVIDER: "attom", ATTOM_API_KEY: "k" })?.name).toBe("attom");
    expect(() => getCompProvider({ COMPS_PROVIDER: "rentcast" })).toThrow(ConfigurationError);
  });
});
