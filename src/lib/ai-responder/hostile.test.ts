import { describe, expect, it } from "vitest";

import { HOSTILE_PHRASES, isHostileInbound } from "./hostile";

describe("hostile phrase list", () => {
  it("is exactly the list Jarrad approved on 2026-10-07, in order, byte for byte", () => {
    expect([...HOSTILE_PHRASES]).toEqual([
      "fuck",
      "scam",
      "spam",
      "leave me alone",
      "piss",
      "asshole",
      "bitch",
      "idiot",
      "stalk",
      "never contact",
      "do not contact",
      "quit texting",
      "stop texting",
      "stop contacting",
      "f off",
      "go to hell",
      "harass",
    ]);
  });
});

describe("isHostileInbound", () => {
  it.each([...HOSTILE_PHRASES])("matches %s", (phrase) => {
    expect(isHostileInbound(`prefix ${phrase} suffix`)).toBe(true);
  });

  it("is case-insensitive and matches at the start of a word anywhere in the inbound", () => {
    expect(isHostileInbound("THIS IS A SCAM")).toBe(true);
    expect(isHostileInbound("Please LEAVE ME ALONE!!")).toBe(true);
    expect(isHostileInbound("you keep texting me, stop texting")).toBe(true);
    expect(isHostileInbound("Go To Hell")).toBe(true);
    expect(isHostileInbound("stalking me")).toBe(true);
    expect(isHostileInbound("scammers")).toBe(true);
  });

  it("PROPOSAL: a phrase must start at the beginning of a word (it may run on into a longer word)", () => {
    // Positives: exact phrase, any case, with punctuation around it.
    for (const body of ["F off!", "f off.", "just f off", "F OFF", "(f off)", "FUCKING stop", "harassing me", "harassment", "scammers"]) {
      expect(isHostileInbound(body), body).toBe(true);
    }
    // Negatives: the phrase only appears inside another word.
    for (const body of [
      "What kind of offer?",
      "kind of offer",
      "of offer",
      "half off the price",
      "pf offer",
      "a beanstalk",
      "Mississippi",
    ]) {
      expect(isHostileInbound(body), body).toBe(false);
    }
  });

  it("does not match ordinary replies", () => {
    for (const body of [
      "no thanks",
      "not interested",
      "wrong number",
      "who is this?",
      "it was sold last month",
      "maybe later",
      "stop",
      "",
    ]) {
      expect(isHostileInbound(body)).toBe(false);
    }
    expect(isHostileInbound(null)).toBe(false);
    expect(isHostileInbound(undefined)).toBe(false);
  });
});
