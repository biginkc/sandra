import { describe, expect, it } from "vitest";

import { suggestOutcome } from "./outcome-suggestion";

const s = (callOutcome: string | null, provider: string | null = "sandra_softphone", talkSeconds: number | null = null) =>
  suggestOutcome({ callOutcome, provider, talkSeconds });

describe("suggestOutcome", () => {
  it.each([
    ["voicemail", "voicemail"],
    ["connected_human", "reached"],
    ["no_answer", "no_answer"],
    ["busy", "no_answer"],
    ["failed", null],
    ["canceled", null],
    ["unknown", null],
    [null, null],
  ] as const)("maps %s to %s", (callOutcome, expected) => {
    expect(s(callOutcome)).toBe(expected);
  });

  it("never guesses an unknown outcome, whatever the talk time or provider", () => {
    expect(s("unknown", "dialpad", 42)).toBeNull();
    expect(s("unknown", "dialpad", 0)).toBeNull();
    expect(s("unknown", "dialpad", null)).toBeNull();
    expect(s("unknown", "jitter", 600)).toBeNull();
  });
});
