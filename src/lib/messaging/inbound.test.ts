import { describe, expect, it } from "vitest";

import { matchesStopKeyword } from "./inbound";

describe("matchesStopKeyword", () => {
  it("opts out on deterministic stop keywords that appear mid-message", () => {
    expect(matchesStopKeyword("STOP")).toBe(true);
    expect(matchesStopKeyword("stop")).toBe(true);
    expect(matchesStopKeyword("stopall")).toBe(true);
    expect(matchesStopKeyword("No stop")).toBe(true);
    expect(matchesStopKeyword("NOT SELLING. STOP")).toBe(true);
    expect(matchesStopKeyword("please remove me")).toBe(true);
    expect(matchesStopKeyword("unsubscribe")).toBe(true);
    expect(matchesStopKeyword("opt out")).toBe(true);
    expect(matchesStopKeyword("opt-out")).toBe(true);
    expect(matchesStopKeyword("optout")).toBe(true);
  });

  it("keeps ambiguous keywords whole-message only", () => {
    expect(matchesStopKeyword("end")).toBe(true);
    expect(matchesStopKeyword("cancel")).toBe(true);
    expect(matchesStopKeyword("quit")).toBe(true);
    expect(matchesStopKeyword("remove")).toBe(true);
  });

  it("does not opt out on non-keyword phrasing or ambiguous mid-message words", () => {
    expect(matchesStopKeyword("the lease ends in May")).toBe(false);
    expect(matchesStopKeyword("remove the fence")).toBe(false);
    expect(matchesStopKeyword("cancel that, I do want to sell")).toBe(false);
    expect(matchesStopKeyword("I might stop by to fix it")).toBe(false);
    expect(matchesStopKeyword("stopped paying")).toBe(false);
  });
});
