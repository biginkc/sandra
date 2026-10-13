import { describe, expect, it } from "vitest";

import { LUNA_DEFAULT_MODEL, lunaModelFromEnv, lunaSuggestionsEnabled } from "./config";

describe("lunaSuggestionsEnabled", () => {
  it("is off by default", () => {
    expect(lunaSuggestionsEnabled({})).toBe(false);
  });
  it("needs the flag to be exactly 1", () => {
    for (const v of ["", "0", "true", "yes", " 1"]) {
      expect(lunaSuggestionsEnabled({ LUNA_SUGGESTIONS_ENABLED: v, OPENAI_API_KEY: "k" })).toBe(false);
    }
  });
  it("needs a non-blank key", () => {
    expect(lunaSuggestionsEnabled({ LUNA_SUGGESTIONS_ENABLED: "1" })).toBe(false);
    expect(lunaSuggestionsEnabled({ LUNA_SUGGESTIONS_ENABLED: "1", OPENAI_API_KEY: "  " })).toBe(false);
  });
  it("is on with flag and key", () => {
    expect(lunaSuggestionsEnabled({ LUNA_SUGGESTIONS_ENABLED: "1", OPENAI_API_KEY: "k" })).toBe(true);
  });
});

describe("lunaModelFromEnv", () => {
  it("defaults to gpt-6-luna and honors LUNA_MODEL", () => {
    expect(LUNA_DEFAULT_MODEL).toBe("gpt-6-luna");
    expect(lunaModelFromEnv({})).toBe("gpt-6-luna");
    expect(lunaModelFromEnv({ LUNA_MODEL: "  " })).toBe("gpt-6-luna");
    expect(lunaModelFromEnv({ LUNA_MODEL: "other" })).toBe("other");
  });
});
